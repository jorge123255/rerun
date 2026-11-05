'use client'

import type { DesktopCoworkerCallSnapshot } from '../../../../packages/contracts/src/desktop-coworker-calls'

export type { DesktopCoworkerCallSnapshot } from '../../../../packages/contracts/src/desktop-coworker-calls'

export type DesktopCoworkerCallOpenTarget = { agentId: string; sessionId: string }

export function createDesktopCoworkerCallsClient(parentAgentId: string, parentSessionId: string) {
    const url = `/api/desktop/sessions/${encodeURIComponent(parentSessionId)}/coworker-calls`
    const controllers = new Set<AbortController>()
    const stopRequests = new Map<string, { expectedRevision: string; requestId: string }>()
    let closed = false

    const owned = (call: DesktopCoworkerCallSnapshot) => call.parentAgentId === parentAgentId && call.parentSessionId === parentSessionId
    const sameIdentity = (current: DesktopCoworkerCallSnapshot, expected: DesktopCoworkerCallSnapshot) =>
        owned(current) && owned(expected) && current.callId === expected.callId && current.parentRunId === expected.parentRunId
        && current.toolCallId === expected.toolCallId && current.targetAgentId === expected.targetAgentId

    async function request<T>(method: 'GET' | 'POST', input?: unknown, signal?: AbortSignal): Promise<T> {
        if (closed) throw new Error('Coworker call owner changed')
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
            const response = await fetch(url, {
                method, cache: 'no-store', signal: requestSignal,
                headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
                body: method === 'POST' ? JSON.stringify(input) : undefined,
            })
            const body = await response.json().catch(() => null) as (T & { error?: unknown }) | null
            requestSignal.throwIfAborted()
            if (closed) throw new Error('Coworker call owner changed')
            if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : method === 'GET' ? 'Could not load coworker calls.' : 'Could not stop the coworker call.')
            if (body === null) throw new Error('Coworker call acknowledgement unavailable.')
            return body
        } finally {
            controllers.delete(controller)
        }
    }

    async function list(signal?: AbortSignal): Promise<DesktopCoworkerCallSnapshot[]> {
        const body = await request<{ calls: DesktopCoworkerCallSnapshot[] }>('GET', undefined, signal)
        if (!Array.isArray(body.calls)) throw new Error('Could not load coworker calls.')
        return body.calls.filter(owned)
    }

    return {
        list,

        async stop(call: DesktopCoworkerCallSnapshot, signal?: AbortSignal): Promise<DesktopCoworkerCallSnapshot> {
            if (!owned(call)) throw new Error('This coworker call belongs to another chat.')
            const previous = stopRequests.get(call.callId)
            const ticket = previous?.expectedRevision === call.revision
                ? previous
                : { expectedRevision: call.revision, requestId: crypto.randomUUID() }
            stopRequests.set(call.callId, ticket)
            const body = await request<{ call: DesktopCoworkerCallSnapshot }>('POST', {
                operation: 'stop', requestId: ticket.requestId, callId: call.callId, expectedRevision: call.revision,
            }, signal)
            if (!body.call || !sameIdentity(body.call, call)) throw new Error('Stop acknowledgement belonged to another coworker call.')
            return body.call
        },

        async openTarget(call: DesktopCoworkerCallSnapshot, onOpenTarget: (target: DesktopCoworkerCallOpenTarget) => Promise<void>, signal?: AbortSignal): Promise<void> {
            const calls = await list(signal)
            const current = calls.find(candidate => sameIdentity(candidate, call))
            if (!current?.targetSessionId) throw new Error('This coworker chat is no longer available. Refresh the call and try again.')
            await onOpenTarget({ agentId: current.targetAgentId, sessionId: current.targetSessionId })
        },

        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
            stopRequests.clear()
        },
    }
}

export type DesktopCoworkerCallsClient = ReturnType<typeof createDesktopCoworkerCallsClient>
