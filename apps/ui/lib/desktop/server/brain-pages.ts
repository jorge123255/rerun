import 'server-only'
import { z, ZodError } from 'zod'
import { brainPageResponseSchema, brainPagesListSchema, brainRevisionContentSchema, brainRevisionSchema, brainSlugSchema } from '@rerun/contracts'
import { DESKTOP_BRAIN_BODY_MAX_BYTES, DESKTOP_BRAIN_RESPONSE_MAX_BYTES, desktopBrainSaveSchema, desktopBrainConfirmSchema, desktopBrainRestoreSchema, desktopBrainRevisionIdSchema } from '../brain-pages'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'

async function boundedJson(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<unknown> {
    const reader = body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Missing Brain response or request body.')
    const chunks: Uint8Array[] = []
    let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        signal.throwIfAborted()
        while (true) {
            const item = await reader.read()
            signal.throwIfAborted()
            if (item.done) break
            size += item.value.byteLength
            if (size > limit) throw new DesktopHttpError(413, 'Brain request or response is too large.')
            chunks.push(item.value)
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { throw new DesktopHttpError(400, 'Invalid Brain JSON.') }
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
}

export async function desktopBrainPagesRequest(runtime: DesktopRuntime, request: Request, segments: string[]): Promise<Response> {
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
        const method = request.method
        let suffix = '', responseSchema: z.ZodType = brainPagesListSchema, inputSchema: z.ZodType | undefined
        if (segments.length === 0 && method === 'GET') responseSchema = brainPagesListSchema
        else if (segments.length > 0) {
            const slug = brainSlugSchema.parse(segments[0])
            suffix = `/${encodeURIComponent(slug)}`
            if (segments.length === 1) {
                if (method === 'GET') responseSchema = brainPageResponseSchema
                else if (method === 'PUT') { inputSchema = desktopBrainSaveSchema; responseSchema = brainPageResponseSchema }
                else if (method === 'DELETE') { inputSchema = desktopBrainRestoreSchema; responseSchema = z.object({ ok: z.literal(true) }) }
                else throw new DesktopHttpError(405, 'Method not allowed.')
            } else if (segments.length === 2 && segments[1] === 'revisions' && method === 'GET') {
                suffix += '/revisions'; responseSchema = z.object({ revisions: z.array(brainRevisionSchema) })
            } else if (segments.length === 3 && segments[1] === 'revisions' && method === 'GET') {
                suffix += `/revisions/${encodeURIComponent(desktopBrainRevisionIdSchema.parse(segments[2]))}`; responseSchema = brainRevisionContentSchema
            } else if (segments.length === 3 && segments[1] === 'revert' && method === 'POST') {
                suffix += `/revert/${encodeURIComponent(desktopBrainRevisionIdSchema.parse(segments[2]))}`; inputSchema = desktopBrainRestoreSchema; responseSchema = brainPageResponseSchema
            } else if (segments.length === 2 && segments[1] === 'confirm' && method === 'POST') {
                suffix += '/confirm'; inputSchema = desktopBrainConfirmSchema; responseSchema = brainPageResponseSchema
            } else throw new DesktopHttpError(404, 'Brain operation not found.')
        } else throw new DesktopHttpError(405, 'Method not allowed.')
        let body: string | undefined
        if (inputSchema) {
            if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new DesktopHttpError(415, 'Use application/json.')
            if (Number(request.headers.get('content-length')) > DESKTOP_BRAIN_BODY_MAX_BYTES) throw new DesktopHttpError(413, 'Brain request is too large.')
            body = JSON.stringify(inputSchema.parse(await boundedJson(request.body, DESKTOP_BRAIN_BODY_MAX_BYTES, signal)))
        }
        signal.throwIfAborted()
        const response = await fetch(`${runtime.engine.origin}/desktop/brain/pages${suffix}`, {
            method, headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
            body, redirect: 'error', cache: 'no-store', signal,
        })
        if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            throw new DesktopHttpError([400, 401, 403, 404, 405, 409, 413, 415, 503].includes(response.status) ? response.status : 502,
                response.status === 409 ? 'This page changed. Reload it before applying your change.' : response.status === 404 ? 'Brain page or revision not found.' : 'Brain storage request failed.')
        }
        const result = responseSchema.parse(await boundedJson(response.body, DESKTOP_BRAIN_RESPONSE_MAX_BYTES, signal))
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        if (error instanceof ZodError) throw new DesktopHttpError(400, 'Invalid Brain data.')
        throw new DesktopHttpError(502, 'Could not reach Brain storage.')
    }
}
