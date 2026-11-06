import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import 'server-only'
import { z } from 'zod'
import { readDesktopRuntime } from '../runtime'
import { openDesktopDatabase } from '../database'
import { findDesktopAgent } from '../store'
import { desktopTriggerEngine } from './engine'
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const paramsSchema = z.strictObject({ agentId: z.uuid(), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), token: z.string().min(1).max(200) })
/** Token-only ingress on the already-bound loopback app listener. No public host or socket is created. */
export async function desktopLocalTriggerIngress(request: Request, params: unknown): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
    try {
        const runtime = await readDesktopRuntime(), host = new URL(runtime.app.origin).host
        if (request.headers.get('host') !== host || (request.headers.get('origin') && request.headers.get('origin') !== runtime.app.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 404, headers })
        assertDesktopWorkspaceAdmission(runtime)
        const parsed = paramsSchema.safeParse(params)
        if (!parsed.success) return new Response(null, { status: 404, headers })
        const purpose = `${request.headers.get('sec-purpose') ?? ''} ${request.headers.get('purpose') ?? ''}`
        const destination = request.headers.get('sec-fetch-dest')
        if (['HEAD', 'OPTIONS'].includes(request.method) || /prefetch|prerender|preview/i.test(purpose) || (destination && destination !== 'empty') || /bot|preview|crawler|spider|quicklook|raycast|maccy|unfurl/i.test(request.headers.get('user-agent') ?? '')) return new Response(null, { status: 204, headers })
        if (!methods.has(request.method)) return new Response(null, { status: 404, headers })
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), reader = request.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0
        const cancel = () => { void reader?.cancel().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try { if (reader) while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1048576) return new Response(null, { status: 413, headers }); chunks.push(part.value) } }
        finally { signal.removeEventListener('abort', cancel); void reader?.cancel().catch(() => {}) }
        const input = parsed.data, db = await openDesktopDatabase(runtime.dataRoot), owner = await findDesktopAgent(db, input.agentId)
        if (!owner) return new Response(null, { status: 404, headers })
        const result = await desktopTriggerEngine(runtime, { op: 'fire', localAgentId: input.agentId, engineAgentId: owner.engineAgentId, slug: input.slug, input: { token: input.token, method: request.method, query: new URL(request.url).search.slice(1), contentType: request.headers.get('content-type') ?? '', body: Buffer.concat(chunks).toString('utf8'), bodyBytes: bytes, ...(request.headers.get('x-desktop-trigger-attempt') ? { attemptFingerprint: request.headers.get('x-desktop-trigger-attempt') } : {}) } }, request.signal) as { status: number; eventId?: string; replay?: boolean; allow?: string[] }
        if (result.status === 202) return Response.json({ eventId: result.eventId, accepted: true, replay: result.replay }, { status: 202, headers })
        if (result.status === 405) return new Response(null, { status: 405, headers: { ...headers, Allow: result.allow?.join(', ') ?? '' } })
        return new Response(null, { status: [404, 409, 413, 503].includes(result.status) ? result.status : 404, headers })
    } catch { return new Response(null, { status: 404, headers }) }
}
