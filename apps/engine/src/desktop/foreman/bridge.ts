import { z } from 'zod'
import { foremanBindingSchema, type DesktopForemanChatRef, type CompanyBriefModelRef, type DesktopForemanBinding, type ForemanBrief } from '@rerun/contracts'
export type ForemanRuntime = { workspaceId?: number | string; launchNonce: string; app: { origin: string }; engine: { apiKey: string } }
export type ForemanIdentity = { engineAgentId: 'foreman'; sessionId: string; runId: string }
export type ForemanTurn = { binding: DesktopForemanBinding; sessionId: string; text: string; brief: ForemanBrief }
export type ForemanBridgeBody =
    | { action: 'brief_model'; chat: DesktopForemanChatRef; model: CompanyBriefModelRef }
    | { action: 'binding'; identity: ForemanIdentity }
    | { action: 'admit'; turn: ForemanTurn }
    | { action: 'show_plan'; binding: DesktopForemanBinding; toolCallId: string; input: unknown }
    | { action: 'navigate'; binding: DesktopForemanBinding; eventId: string; intent: unknown }
    | { action: 'discover'; binding: DesktopForemanBinding; url: string }
const bindingResponse = z.strictObject({ binding: foremanBindingSchema, discovery: z.boolean() })
export function createDesktopForemanBridge(runtime: ForemanRuntime, network: typeof fetch = fetch) {
    const origin = new URL(runtime.app.origin)
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== runtime.app.origin || !/^[a-f0-9]{64}$/.test(runtime.engine.apiKey) || !z.uuid().safeParse(runtime.launchNonce).success) throw new Error('Desktop Foreman callback is unavailable.')
    const closed = new AbortController()
    async function request(body: ForemanBridgeBody, stop?: AbortSignal): Promise<unknown> {
        const signal = AbortSignal.any([closed.signal, ...(stop ? [stop] : []), AbortSignal.timeout(body.action === 'discover' ? 60_000 : 20_000)])
        signal.throwIfAborted()
        const encoded = JSON.stringify({ ...body, launchNonce: runtime.launchNonce })
        if (Buffer.byteLength(encoded) > 32 * 1024) throw new Error('Foreman request exceeds limit.')
        const response = await network(`${origin.origin}/api/desktop/internal/foreman`, { method: 'POST', headers: { authorization: `Bearer ${runtime.engine.apiKey}`, 'content-type': 'application/json' }, body: encoded, signal, redirect: 'error', credentials: 'omit' })
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Foreman acknowledgement unavailable.')
        const chunks: Uint8Array[] = []; let length = 0
        const cancel = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
            while (true) {
                signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted()
                if (next.done) break
                length += next.value.byteLength
                if (length > 64 * 1024) throw new Error('Foreman response exceeds limit.')
                chunks.push(next.value)
            }
            if (!response.ok) throw new Error('The Foreman request is unavailable or no longer current.')
            return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
    }
    return {
        request,
        workspaceId: String(runtime.workspaceId ?? '1'),
        async binding(identity: ForemanIdentity, signal?: AbortSignal) { return bindingResponse.parse(await request({ action: 'binding', identity }, signal)) },
        async admit(turn: ForemanTurn, signal: AbortSignal) { z.object({ ok: z.literal(true) }).parse(await request({ action: 'admit', turn }, signal)) },
        close() { closed.abort() },
    }
}
