import { describe, expect, it, vi } from 'vitest'
import type { DesktopClaudePlanChatIdentity, DesktopClaudePlanChatInput, DesktopClaudePlanChatResult } from '@rerun/contracts'
import { createDesktopClaudePlanRunner } from './runner'

const identity: DesktopClaudePlanChatIdentity = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', credentialRevision: '1' }
const input: DesktopClaudePlanChatInput = { message: 'Hello', model: 'claude-sonnet-4-6', thinking: 'adaptive' }

function fixture(events: unknown[] = []) {
    const results = new Map<string, DesktopClaudePlanChatResult>()
    const runner = {
        dispatch: vi.fn(async function* () { for (const event of events) yield event },
        stop: vi.fn(async () => {}),
    }
    const outcomes = {
        begin: vi.fn(async () => results.get('current') ?? 'execute' as const),
        complete: vi.fn(async (result: DesktopClaudePlanChatResult) => { results.set('current', result) }),
        read: vi.fn(async () => results.get('current') ?? null),
    }
    const authority = vi.fn(async () => {})
    return { runner, outcomes, authority, results }
}

describe('desktop Claude plan runner', () => {
    it('captures original stream/tool/source events and authority checks once before and after dispatch', async () => {
        const parts = fixture([
            { type: 'text-delta', text: 'Hello' },
            { type: 'reasoning-delta', text: 'Thinking' },
            { type: 'tool-call', toolCallId: 'call', toolName: 'fs_read', input: { path: 'a.md' } },
            { type: 'source', url: 'https://example.com/', title: 'Example' },
            { type: 'usage', usedTokens: 10, maxTokens: 100 },
            { type: 'finish', finishReason: 'stop' },
        ])
        const service = createDesktopClaudePlanRunner(parts.runner, parts.outcomes, parts.authority, { now: () => '2026-11-05T10:00:00.000Z' })
        const result = await service.dispatch(identity, input)
        expect(result.status).toBe('completed')
        expect(result.text).toBe('Hello')
        expect(result.events).toHaveLength(6)
        expect(parts.authority).toHaveBeenCalledTimes(2)
        expect(parts.runner.stop).not.toHaveBeenCalled()
    })

    it('returns a saved outcome on restart with zero new runner calls', async () => {
        const parts = fixture([{ type: 'text-delta', text: 'Saved' }, { type: 'finish', finishReason: 'stop' }])
        const service = createDesktopClaudePlanRunner(parts.runner, parts.outcomes, parts.authority)
        await service.dispatch(identity, input)
        await expect(service.dispatch(identity, input)).resolves.toMatchObject({ status: 'completed', text: 'Saved' })
        expect(parts.runner.dispatch).toHaveBeenCalledTimes(1)
    })

    it('stops the exact process and records cancellation without replaying it', async () => {
        const parts = fixture([{ type: 'text-delta', text: 'partial' }, { type: 'finish', finishReason: 'cancelled' }])
        const service = createDesktopClaudePlanRunner(parts.runner, parts.outcomes, parts.authority)
        const controller = new AbortController()
        controller.abort()
        const result = await service.dispatch(identity, input, controller.signal)
        expect(result.status).toBe('cancelled')
        expect(parts.runner.stop).toHaveBeenCalledWith(identity, expect.any(AbortSignal))
        expect(parts.runner.dispatch).not.toHaveBeenCalled()
    })

    it('rejects non-HTTP source metadata rather than turning it into a citation', async () => {
        const parts = fixture([{ type: 'source', url: 'file:///tmp/private' }])
        const service = createDesktopClaudePlanRunner(parts.runner, parts.outcomes, parts.authority)
        await expect(service.dispatch(identity, input)).resolves.toMatchObject({ status: 'uncertain' })
    })
})
