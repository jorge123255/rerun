'use client'

import {
    FOREMAN_AGENT_ID,
    desktopCoworkerCallListSchema,
    desktopCoworkerCallStopResultSchema,
    type DesktopCoworkerCallSnapshot,
} from '@rerun/contracts'

export type { DesktopCoworkerCallSnapshot } from '@rerun/contracts'

export type DesktopCoworkerCallOpenTarget = { agentId: string; sessionId: string }

const MAX_RESPONSE_BYTES = 1_000_000
const REQUEST_TIMEOUT_MS = 10_000

export class DesktopCoworkerCallStopError extends Error {
    constructor(message: string, readonly call?: DesktopCoworkerCallSnapshot) {
        super(message)
        this.name = 'DesktopCoworkerCallStopError'
    }
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > MAX_RESPONSE_BYTES) throw new Error('Coworker call response is too large.')
            chunks.push(item.value)
        }
    } finally { await reader.cancel().catch(() => undefined) }
    try {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
        throw new Error('Coworker call response was malformed.')
    }
}

function errorMessage(body: unknown, fallback: string): string {
    return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : fallback
}

export function createDesktopCoworkerCallsClient(parentAgentId: string, parentSessionId: string) {
    const resource = parentAgentId === FOREMAN_AGENT_ID ? 'foreman' : 'sessions'
    const url = `/api/desktop/${resource}/${encodeURIComponent(parentSessionId)}/coworker-calls`
    const controllers = new Set<AbortController>()
    const stopRequests = new Map<string, { expectedRevision: string; requestId: string }>()
    let closed = false

    const owned = (call: DesktopCoworkerCallSnapshot) => call.parentAgentId === parentAgentId && call.parentSessionId === parentSessionId
    const sameIdentity = (current: DesktopCoworkerCallSnapshot, expected: DesktopCoworkerCallSnapshot) =>
        owned(current) && owned(expected) && current.callId === expected.callId && current.parentRunId === expected.parentRunId
        && current.toolCallId === expected.toolCallId && current.targetAgentId === expected.targetAgentId

    async function request(method: 'GET' | 'POST', input?: unknown, signal?: AbortSignal): Promise<{ ok: boolean; body: unknown }> {
        if (closed) throw new Error('Coworker call owner changed')
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])])
            const response = await fetch(url, {
                method, cache: 'no-store', signal: requestSignal,
                headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
                body: method === 'POST' ? JSON.stringify(input) : undefined,
            })
            const body = await readBody(response, requestSignal)
            requestSignal.throwIfAborted()
            if (closed) throw new Error('Coworker call owner changed')
            return { ok: response.ok, body }
        } catch (cause) {
            if (closed) throw new Error('Coworker call owner changed')
            throw cause
        } finally {
            controllers.delete(controller)
        }
    }

    async function list(signal?: AbortSignal): Promise<DesktopCoworkerCallSnapshot[]> {
        const { ok, body } = await request('GET', undefined, signal)
        if (!ok) throw new Error(errorMessage(body, 'Could not load coworker calls.'))
        const parsed = desktopCoworkerCallListSchema.safeParse(body)
        if (!parsed.success) throw new Error('Coworker call response was malformed.')
        if (parsed.data.calls.some(call => !owned(call))) throw new Error('Coworker call response belonged to another chat.')
        return parsed.data.calls
    }

    return {
        list,

        async stop(call: DesktopCoworkerCallSnapshot, signal?: AbortSignal): Promise<DesktopCoworkerCallSnapshot> {
            if (!owned(call)) throw new DesktopCoworkerCallStopError('This coworker call belongs to another chat.')
            const previous = stopRequests.get(call.callId)
            const ticket = previous?.expectedRevision === call.revision
                ? previous
                : { expectedRevision: call.revision, requestId: crypto.randomUUID() }
            stopRequests.set(call.callId, ticket)
            const { ok, body } = await request('POST', {
                operation: 'stop', requestId: ticket.requestId, callId: call.callId, expectedRevision: call.revision,
            }, signal)
            const parsed = desktopCoworkerCallStopResultSchema.safeParse(body)
            if (parsed.success && !sameIdentity(parsed.data.call, call)) throw new DesktopCoworkerCallStopError('Stop acknowledgement belonged to another coworker call.')
            if (!ok) throw new DesktopCoworkerCallStopError(errorMessage(body, 'Could not stop the coworker call.'), parsed.success ? parsed.data.call : undefined)
            if (!parsed.success) throw new DesktopCoworkerCallStopError('Stop acknowledgement was malformed.')
            return parsed.data.call
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
