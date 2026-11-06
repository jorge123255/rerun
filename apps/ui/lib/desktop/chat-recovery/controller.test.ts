import { describe, expect, it, vi } from 'vitest'
import { DesktopChatRecoveryController, desktopRecoveryScopeKey, type DesktopRecoveryPorts, type DesktopRecoveryScope } from './controller'

function scope(partial: Partial<DesktopRecoveryScope> = {}): DesktopRecoveryScope {
    return { agentId: 'agent-1', tabUid: 'tab-1', sessionId: 'session-1', liveSessionId: 'engine-1', runId: 'run-1', requestId: null, modelRevision: 0, ...partial }
}

function ports(): DesktopRecoveryPorts & { calls: string[] } {
    const calls: string[] = []
    return {
        calls,
        retryLastTurn: vi.fn(() => { calls.push('retry') }),
        continueRun: vi.fn(() => { calls.push('continue') }),
        stopRun: vi.fn(() => { calls.push('stop') }),
        newConversation: vi.fn(() => { calls.push('new-conversation') }),
        switchModel: vi.fn(() => { calls.push('switch-model') }),
        reconnectProvider: vi.fn(() => { calls.push('reconnect') }),
    }
}

function controller(current: () => DesktopRecoveryScope, p: DesktopRecoveryPorts, canRetry = true) {
    return new DesktopChatRecoveryController(p, current, () => canRetry)
}

describe('desktop chat recovery controller', () => {
    it('classifies a missing engine session as session_gone and offers only a new conversation', () => {
        const p = ports()
        let current = scope()
        const c = controller(() => current, p)
        const notice = c.observe('session not found for this agent')
        expect(notice?.kind).toBe('session_gone')
        expect(c.act('new-conversation')).toBe(true)
        expect(p.calls).toEqual(['new-conversation'])
        expect(c.act('retry')).toBe(false)
        expect(c.act('switch-model')).toBe(false)
    })

    it('unwraps the engine error envelope before classifying', () => {
        const p = ports()
        const c = controller(() => scope(), p)
        const notice = c.observe('{"error":"run_in_flight"}')
        expect(notice?.kind).toBe('run_in_flight')
        expect(notice?.message).toBe('run_in_flight')
    })

    it('offers stop for run_in_flight and continue for interrupted, never retry', () => {
        const p = ports()
        const c = controller(() => scope(), p)
        c.observe('run_in_flight')
        expect(c.act('stop')).toBe(true)
        expect(c.act('retry')).toBe(false)
        c.observe('interrupted: engine restarted')
        expect(c.act('continue')).toBe(true)
        expect(c.act('retry')).toBe(false)
        expect(p.calls).toEqual(['stop', 'continue'])
    })

    it('offers retry for a rejected thinking replay and refuses to offer a model switch', () => {
        const p = ports()
        const c = controller(() => scope(), p)
        c.observe('Invalid `signature` in `thinking` block at messages.402')
        const notice = c.view()
        expect(notice?.kind).toBe('thinking_replay')
        expect(c.act('retry')).toBe(true)
        expect(c.act('switch-model')).toBe(false)
        expect(p.calls).toEqual(['retry'])
    })

    it('offers switch-model for a refused model and reconnect for an unauthorized connection', () => {
        const p = ports()
        const c = controller(() => scope(), p)
        c.observe('The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account')
        expect(c.view()?.kind).toBe('usage_limit')
        expect(c.act('switch-model')).toBe(true)
        c.observe('Failed to authenticate. API Error: 401 Invalid bearer token')
        expect(c.view()?.kind).toBe('unauthorized')
        expect(c.act('reconnect')).toBe(true)
        expect(p.calls).toEqual(['switch-model', 'reconnect'])
    })

    it('hides the notice and refuses actions once the chat scope changes', () => {
        const p = ports()
        let current = scope()
        const c = controller(() => current, p)
        c.observe('overloaded')
        current = scope({ tabUid: 'tab-2', sessionId: 'session-2' })
        expect(c.view()).toBeNull()
        expect(c.act('retry')).toBe(false)
        expect(c.act('switch-model')).toBe(false)
        expect(p.calls).toEqual([])
    })

    it('does not let a late failed-run error for another run replace the current notice', () => {
        const p = ports()
        const c = controller(() => scope({ runId: 'run-2' }), p)
        c.observe('session not found for this agent')
        c.observeRunFailure('run-1', 'overloaded')
        expect(c.view()?.kind).toBe('session_gone')
        c.observeRunFailure('run-2', 'context window exceeded: prompt is too long')
        expect(c.view()?.kind).toBe('context_window')
    })

    it('keeps the same generation for an identical re-observed error and bumps it for a new one', () => {
        const p = ports()
        const c = controller(() => scope(), p)
        const first = c.observe('overloaded')
        const again = c.observe('overloaded')
        expect(again?.binding.generation).toBe(first?.binding.generation)
        const next = c.observe('provider returned error')
        expect(next?.binding.generation).toBe((first?.binding.generation ?? 0) + 1)
    })

    it('records the model revision at observation time without hiding the notice on a later pick', () => {
        const p = ports()
        let current = scope({ modelRevision: 3 })
        const c = controller(() => current, p)
        const notice = c.observe('overloaded')
        expect(notice?.binding.modelRevision).toBe(3)
        current = scope({ modelRevision: 4 })
        expect(c.view()?.kind).toBe('overloaded')
        expect(c.act('retry')).toBe(true)
    })

    it('refuses retry when there is no user message to resend', () => {
        const p = ports()
        const c = controller(() => scope(), p, false)
        c.observe('overloaded')
        expect(c.act('retry')).toBe(false)
        expect(p.calls).toEqual([])
    })

    it('clears the notice and rejects further actions', () => {
        const p = ports()
        const c = controller(() => scope(), p)
        c.observe('generic failure')
        c.clear()
        expect(c.view()).toBeNull()
        expect(c.act('retry')).toBe(false)
    })

    it('binds the scope key to coworker, tab, session, run and request identity', () => {
        const base = scope()
        expect(desktopRecoveryScopeKey(base)).not.toBe(desktopRecoveryScopeKey({ ...base, agentId: 'agent-2' }))
        expect(desktopRecoveryScopeKey(base)).not.toBe(desktopRecoveryScopeKey({ ...base, tabUid: 'tab-9' }))
        expect(desktopRecoveryScopeKey(base)).not.toBe(desktopRecoveryScopeKey({ ...base, sessionId: 'session-9' }))
        expect(desktopRecoveryScopeKey(base)).not.toBe(desktopRecoveryScopeKey({ ...base, liveSessionId: 'engine-9' }))
        expect(desktopRecoveryScopeKey(base)).not.toBe(desktopRecoveryScopeKey({ ...base, runId: 'run-9' }))
        expect(desktopRecoveryScopeKey(base)).not.toBe(desktopRecoveryScopeKey({ ...base, requestId: 'req-1' }))
        expect(desktopRecoveryScopeKey(base)).toBe(desktopRecoveryScopeKey({ ...base }))
    })
})
