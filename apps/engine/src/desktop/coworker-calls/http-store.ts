import { DESKTOP_COWORKER_CALL_STATUS_LIST, desktopCoworkerCallCallerViewSchema } from '@rerun/contracts'
import { z } from 'zod'
import type { CoworkerCallAuthorization, CoworkerCallTargetAdmission, DesktopCoworkerCallDeps, PreparedCoworkerCallTarget } from './runtime.js'
import type { CoworkerCallExpect, CoworkerCallPatch, CoworkerCallRow, CoworkerCallStore } from './store.js'

type Runtime = { launchNonce: string; app: { origin: string }; engine: { apiKey: string } }
const MAX_BYTES = 256_000
const REFUSAL_BYTES = 8_000
export const COWORKER_CALL_REFUSAL_MAX_CHARS = 400
const BRIDGE_TIMEOUT_MS = 30_000

/**
 * Why a hand-off to the app did not go through, in words the calling coworker can act on.
 * `unreachable`: the app could not be reached, did not answer in time, or failed on its side (5xx).
 * `refused`: the app answered and declined this call (4xx, or an answer that says not ok); the
 * message is the app's own reason, never a body the engine made up.
 */
export class CoworkerCallBridgeError extends Error {
    constructor(message: string, readonly kind: 'unreachable' | 'refused', readonly status: number | null = null) {
        super(message)
        this.name = 'CoworkerCallBridgeError'
    }
}

export const COWORKER_CALL_APP_UNREACHABLE = 'The Rerun app could not be reached to hand this call over. Try again in a moment.'
export const COWORKER_CALL_APP_TIMEOUT = 'The Rerun app did not answer in time to hand this call over. Try again in a moment.'
export const COWORKER_CALL_APP_FAILED = 'The Rerun app could not handle this call right now. Try again in a moment.'
export const COWORKER_CALL_APP_REFUSED = 'The Rerun app refused this call.'

/** The app's own reason, on one line and bounded. Anything that is not a non-empty string is dropped. */
export function coworkerCallRefusalText(value: unknown): string | null {
    if (typeof value !== 'string') return null
    // Control and format characters would let a reason pose as more than one line of tool output.
    const text = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()
    if (!text) return null
    return text.length > COWORKER_CALL_REFUSAL_MAX_CHARS ? `${text.slice(0, COWORKER_CALL_REFUSAL_MAX_CHARS - 1).trimEnd()}…` : text
}

/** The body as text, or null when it is larger than `limit`. */
async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<string | null> {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > limit) return null
            chunks.push(item.value)
        }
    } finally {
        await reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks).toString('utf8')
}

function rowOf(value: unknown): CoworkerCallRow | null {
    if (value == null) return null
    if (!value || typeof value !== 'object' || typeof (value as CoworkerCallRow).callId !== 'string') throw new Error('Coworker call store returned an invalid row')
    return value as CoworkerCallRow
}

export function createHttpCoworkerCallBridge(runtime: Runtime, epoch: string, fetchImpl: typeof fetch = fetch): {
    store: CoworkerCallStore
    authorize: (input: { engineAgentId: string; engineSessionId: string; engineRunId: string }) => Promise<{ ok: true; caller: CoworkerCallAuthorization } | { ok: false; reason: string }>
    prepareTarget: (input: CoworkerCallTargetAdmission) => Promise<PreparedCoworkerCallTarget>
    adoptPublicSession: (input: { publicAgentId: string; engineSessionId: string; title: string }) => Promise<{ publicSessionId: string }>
    readCalls: NonNullable<DesktopCoworkerCallDeps['readCalls']>
} {
    async function post(op: string, payload: unknown): Promise<unknown> {
        // The app answers these from its own database. Ten seconds was not enough while it was busy
        // starting several coworkers at once, and the caller was told the hand-off timed out instead
        // of the app's real answer.
        const stop = AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
        let response: Response
        try {
            response = await fetchImpl(`${runtime.app.origin}/api/webhooks/engine`, {
                method: 'POST',
                redirect: 'error',
                headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'desktop.coworker-call', launchNonce: runtime.launchNonce, epoch, op, payload }),
                signal: stop,
            })
        } catch {
            throw new CoworkerCallBridgeError(stop.aborted ? COWORKER_CALL_APP_TIMEOUT : COWORKER_CALL_APP_UNREACHABLE, 'unreachable')
        }
        // The app's own refusal is passed on: a 4xx carries the reason the app wrote for this call.
        if (response.status >= 400 && response.status < 500) {
            const text = response.body ? await readBounded(response.body, REFUSAL_BYTES).catch(() => null) : null
            let reason: string | null = null
            try { reason = coworkerCallRefusalText((JSON.parse(text ?? '') as { error?: unknown } | null)?.error) } catch { /* not the app's JSON answer */ }
            throw new CoworkerCallBridgeError(reason ?? COWORKER_CALL_APP_REFUSED, 'refused', response.status)
        }
        if (!response.ok || !response.body) {
            await response.body?.cancel().catch(() => undefined)
            throw new CoworkerCallBridgeError(COWORKER_CALL_APP_FAILED, 'unreachable', response.status)
        }
        let text: string | null
        try { text = await readBounded(response.body, MAX_BYTES) }
        catch { throw new CoworkerCallBridgeError(stop.aborted ? COWORKER_CALL_APP_TIMEOUT : COWORKER_CALL_APP_UNREACHABLE, 'unreachable') }
        if (text === null) throw new Error('Coworker call store response is too large')
        const parsed = JSON.parse(text) as { ok?: boolean; result?: unknown; error?: unknown }
        if (parsed.ok !== true) throw new CoworkerCallBridgeError(coworkerCallRefusalText(parsed.error) ?? COWORKER_CALL_APP_REFUSED, 'refused', response.status)
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
            const result = await post('insert', { row }) as { inserted?: boolean; reason?: 'exists' | 'fanout' | 'duplicate'; row?: unknown }
            if (result.inserted === true) return { inserted: true, row: rowOf(result.row) ?? row }
            return { inserted: false, reason: result.reason === 'fanout' || result.reason === 'duplicate' ? result.reason : 'exists', row: rowOf(result.row) }
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
        prepareTarget: async input => {
            const prepared = z.strictObject({ publicAgentId: z.string().min(1), engineAgentId: z.string().min(1), connectionId: z.string().min(1), model: z.string().min(1) }).parse(await post('prepare-target', input))
            if (prepared.publicAgentId !== input.target.publicAgentId || prepared.engineAgentId !== input.target.engineAgentId) throw new Error('Coworker identity changed')
            return prepared
        },
        adoptPublicSession: async input => {
            const result = await post('adopt-session', input) as { publicSessionId?: string }
            if (!result?.publicSessionId) throw new Error('Coworker call chat was not saved')
            return { publicSessionId: result.publicSessionId }
        },
        readCalls: async input => z.strictObject({ calls: z.array(desktopCoworkerCallCallerViewSchema).max(DESKTOP_COWORKER_CALL_STATUS_LIST) }).parse(await post('status', input)).calls,
    }
}
