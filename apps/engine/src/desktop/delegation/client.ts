import { env } from '../../config/env.js'
import { abortable } from '../web-fetch/transport.js'
import type { DelegationStore, ReceiptStore } from './types.js'
import type { Allocation, EngineSource } from './protocol.js'

export function delegationClient(launchNonce: string, closing: AbortSignal) {
    async function request<T>(operation: string, data: unknown, signal = closing): Promise<T> {
        const config = env(), origin = new URL(config.RERUN_HUB_BASE_URL ?? '')
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || !config.RERUN_API_KEY) throw new Error('Delegation connection unavailable')
        const body = JSON.stringify({ operation, launchNonce, data })
        if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Delegation record exceeds limit')
        const stop = AbortSignal.any([signal, closing, AbortSignal.timeout(10000)])
        const response = await abortable(fetch(`${origin.origin}/api/desktop/internal/delegation`, { method: 'POST', headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' }, body, signal: stop, redirect: 'error' }), stop)
        const reader = response.body?.getReader(); if (!reader) throw new Error('Delegation response unavailable')
        const chunks: Uint8Array[] = []; let length = 0
        try {
            for (;;) { const part = await abortable(reader.read(), stop); if (part.done) break; length += part.value.byteLength; if (length > 4 * 1024 * 1024) throw new Error('Delegation response exceeds limit'); chunks.push(part.value) }
            if (!response.ok) throw new Error('Delegation authority or receipt changed')
            return (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result: T }).result
        } finally { await reader.cancel().catch(() => {}) }
    }
    const store: DelegationStore = {
        reserve: record => request('record-reserve', record), save: (record, expectedRevision) => request('record-save', { record, expectedRevision }),
        read: id => request('record-read', { id }), list: sessionId => request('record-list', { sessionId }),
    }
    const receipts: ReceiptStore = { read: requestId => request('stop-read', { requestId }), reserve: (requestId, receipt) => request('stop-reserve', { requestId, receipt }), put: (requestId, receipt) => request('stop-settle', { requestId, receipt }) }
    return { request, store, receipts,
        authority: (source: EngineSource, signal: AbortSignal) => request<{ source: import('./types.js').Source; webFetch: boolean }>('authority', source, signal),
        resource: (token: string) => request<Allocation>('resource-read', { token }),
        saveResource: (record: Allocation, expectedRevision: string) => request<Allocation>('resource-save', { record, expectedRevision }),
    }
}
export type DelegationClient = ReturnType<typeof delegationClient>
