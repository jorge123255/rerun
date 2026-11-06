import { z } from 'zod'
import { triggerRequestViewSchema, type TriggerRequestDecision, type TriggerRequestView } from './types'

const envelope = z.strictObject({ request: triggerRequestViewSchema.nullable() })
const keySchema = z.string().regex(/^[a-f0-9]{64}$/)
export function createTriggerRequestsClient(sessionId: string, key: string, transport: typeof fetch = fetch) {
    keySchema.parse(key)
    const path = `/api/desktop/sessions/${encodeURIComponent(sessionId)}/trigger-requests`
    async function request(action?: 'reconcile' | 'stop' | 'decide', decision?: TriggerRequestDecision, signal?: AbortSignal) {
        const response = await transport(action ? path : `${path}?key=${key}`, {
            method: action ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(130_000), ...(signal ? [signal] : [])]),
            ...(action ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, key, ...(decision ? { decision } : {}) }) } : {}),
        })
        if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            throw new Error(response.status === 409 ? 'The saved request changed or its acknowledgement is unknown. Check the result before retrying.' : 'Could not read or confirm the webhook request. Check the saved outcome.')
        }
        return response
    }
    async function readResponse(response: Response): Promise<TriggerRequestView | null> {
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Webhook request response is unavailable')
        const chunks: Uint8Array[] = []; let bytes = 0
        try {
            for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('Webhook request response is too large'); chunks.push(part.value) }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        const joined = new Uint8Array(bytes); let offset = 0
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
        const view = envelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined))).request
        if (view && (view.key !== key || view.link.sessionId !== sessionId)) throw new Error('Webhook result belongs to another conversation')
        return view
    }
    return {
        read: async (signal?: AbortSignal) => readResponse(await request(undefined, undefined, signal)),
        reconcile: async (signal?: AbortSignal) => readResponse(await request('reconcile', undefined, signal)),
        stop: async (signal?: AbortSignal) => readResponse(await request('stop', undefined, signal)),
        async decide(decision: TriggerRequestDecision, signal?: AbortSignal) {
            const response = await request('decide', decision, signal)
            if (response.headers.get('x-session-id') !== sessionId || response.headers.get('x-trigger-request-key') !== key || !response.headers.get('x-run-id')) {
                void response.body?.cancel().catch(() => {})
                throw new Error('Webhook response acknowledgement did not match this exact request')
            }
            return response
        },
    }
}
export type TriggerRequestsClient = ReturnType<typeof createTriggerRequestsClient>
