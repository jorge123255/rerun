import type { CoworkerCallAuthorization } from './runtime.js'
import type { CoworkerCallExpect, CoworkerCallPatch, CoworkerCallRow, CoworkerCallStore } from './store.js'

type Runtime = { app: { origin: string }; engine: { apiKey: string } }
const MAX_BYTES = 256_000

function rowOf(value: unknown): CoworkerCallRow | null {
    if (value == null) return null
    if (!value || typeof value !== 'object' || typeof (value as CoworkerCallRow).callId !== 'string') throw new Error('Coworker call store returned an invalid row')
    return value as CoworkerCallRow
}

export function createHttpCoworkerCallBridge(runtime: Runtime, epoch: string, fetchImpl: typeof fetch = fetch): {
    store: CoworkerCallStore
    authorize: (input: { engineAgentId: string; engineSessionId: string; engineRunId: string }) => Promise<{ ok: true; caller: CoworkerCallAuthorization } | { ok: false; reason: string }>
    adoptPublicSession: (input: { publicAgentId: string; engineSessionId: string; title: string }) => Promise<{ publicSessionId: string }>
} {
    async function post(op: string, payload: unknown): Promise<unknown> {
        const stop = AbortSignal.timeout(10_000)
        const response = await fetchImpl(`${runtime.app.origin}/api/webhooks/engine`, {
            method: 'POST',
            redirect: 'error',
            headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'desktop.coworker-call', epoch, op, payload }),
            signal: stop,
        })
        if (!response.ok || !response.body) {
            await response.body?.cancel().catch(() => undefined)
            throw new Error('Coworker call store is unavailable')
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
            while (true) {
                const item = await reader.read()
                if (item.done) break
                size += item.value.byteLength
                if (size > MAX_BYTES) throw new Error('Coworker call store response is too large')
                chunks.push(item.value)
            }
        } finally {
            await reader.cancel().catch(() => undefined)
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: boolean; result?: unknown }
        if (parsed.ok !== true) throw new Error('Coworker call store rejected the request')
        return parsed.result
    }
    const store: CoworkerCallStore = {
        adoptEpoch: (next, now) => post('adopt-epoch', { epoch: next, now }).then(() => undefined),
        getBySource: async sourceKey => rowOf(await post('get-by-source', { sourceKey })),
        get: async callId => rowOf(await post('get', { callId })),
        listByParentSession: async parentSessionId => {
            const result = await post('list', { parentSessionId })
            if (!Array.isArray(result)) throw new Error('Coworker call store returned an invalid list')
            return result.map(item => rowOf(item)).filter((item): item is CoworkerCallRow => item !== null)
        },
        inbound: async engineRunId => rowOf(await post('inbound', { engineRunId })),
        insertReserved: async row => {
            const result = await post('insert', { row }) as { inserted?: boolean; reason?: 'exists' | 'fanout'; row?: unknown }
            if (result.inserted === true) return { inserted: true, row: rowOf(result.row) ?? row }
            return { inserted: false, reason: result.reason === 'fanout' ? 'fanout' : 'exists', row: rowOf(result.row) }
        },
        claim: async (callId, nextEpoch, now) => rowOf(await post('claim', { callId, epoch: nextEpoch, now })),
        patch: async (callId, expect: CoworkerCallExpect, patch: CoworkerCallPatch, now) => rowOf(await post('patch', { callId, expect, patch, now })),
    }
    return {
        store,
        authorize: async input => {
            const result = await post('authorize', input) as { ok?: boolean; reason?: string; caller?: CoworkerCallAuthorization }
            if (result?.ok !== true || !result.caller?.publicAgentId) return { ok: false, reason: result?.reason || 'This run can no longer call a coworker.' }
            return { ok: true, caller: result.caller }
        },
        adoptPublicSession: async input => {
            const result = await post('adopt-session', input) as { publicSessionId?: string }
            if (!result?.publicSessionId) throw new Error('Coworker call chat was not saved')
            return { publicSessionId: result.publicSessionId }
        },
    }
}
