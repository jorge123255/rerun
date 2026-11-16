import 'server-only'
import { z } from 'zod'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER, desktopDocumentRequestSchema, desktopDocumentScopeSchema, desktopDocumentStagedUploadSchema } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { desktopRoute } from '../http'
import { previewResultBytes } from '../result-files/preview'
import type { DesktopDocumentAttachmentService } from './service'
import { desktopStagedUploadLimitMessage } from './staged-upload'

const MAX_BODY_BYTES = Math.ceil(DESKTOP_DOCUMENT_MAX_BYTES / 3) * 4 + 16_384
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const readQuery = desktopDocumentScopeSchema.omit({ agentId: true }).extend({ attachmentId: z.string().uuid().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), view: z.enum(['read', 'preview', 'download']).optional(), page: z.coerce.number().int().min(1).max(10_000).optional(), scale: z.coerce.number().min(.5).max(2).optional() }).strict()
async function readJson(request: Request, signal: AbortSignal): Promise<unknown> {
    const declared = request.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new DesktopHttpError(413, 'Document request exceeds its limit.')
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Missing document request body.')
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    const chunks: Uint8Array[] = []; let length = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const part = await reader.read(); signal.throwIfAborted()
            if (part.done) break
            length += part.value.byteLength
            if (length > MAX_BODY_BYTES) throw new DesktopHttpError(413, 'Document request exceeds its limit.')
            chunks.push(part.value)
        }
        const bytes = new Uint8Array(length); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}) }
}
function decode(value: string) {
    if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new DesktopHttpError(400, 'Document bytes are invalid.')
    const bytes = Buffer.from(value, 'base64')
    if (!bytes.byteLength || bytes.byteLength > DESKTOP_DOCUMENT_MAX_BYTES || bytes.toString('base64') !== value) throw new DesktopHttpError(400, 'Document bytes are invalid.')
    return new Uint8Array(bytes)
}
export function desktopDocumentAttachmentsApi(service: DesktopDocumentAttachmentService) {
    return async (request: Request, agentId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        try {
            if (request.method === 'GET') {
                const search = new URL(request.url).searchParams
                if ([...search.keys()].some(key => search.getAll(key).length > 1)) throw new DesktopHttpError(400, 'Duplicate document query fields.')
                const query = readQuery.parse(Object.fromEntries(search))
                const scope = { agentId, tabUid: query.tabUid, ...(query.sessionId ? { sessionId: query.sessionId } : {}), ...(query.questionId ? { questionId: query.questionId } : {}) }
                if (!query.attachmentId) {
                    if (query.view || query.sha256 || query.page || query.scale) throw new DesktopHttpError(400, 'Choose an attachment.')
                    return Response.json({ attachments: await service.list(scope, signal) }, { headers })
                }
                if (!query.sha256 || !query.view) throw new DesktopHttpError(400, 'Choose an exact attachment identity.')
                const result = await service.read(scope, query.attachmentId, query.sha256, signal, query.view === 'preview' ? 'preview' : 'source')
                if (query.view === 'preview') {
                    const response = await previewResultBytes(result.renderedImage ? 'preview.png' : result.attachment.name,
                        result.bytes, { signal, page: query.page, scale: query.scale })
                    await service.assertReadable(scope, query.attachmentId, query.sha256, signal)
                    response.headers.set('x-rerun-document-sha256', query.sha256)
                    return response
                }
                await service.assertReadable(scope, query.attachmentId, query.sha256, signal)
                const name = encodeURIComponent(result.attachment.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
                return new Response(new Uint8Array(result.bytes), { headers: { ...headers, 'Content-Type': query.view === 'download' || result.attachment.conversion.renderedImage ? 'application/octet-stream' : result.attachment.mimeType, 'Content-Length': String(result.bytes.byteLength), 'Content-Disposition': `attachment; filename*=UTF-8''${name}`, 'x-rerun-document-sha256': query.sha256 } })
            }
            if (request.method !== 'POST') return Response.json({ error: 'Method unavailable.' }, { status: 405, headers })
            const body = desktopDocumentRequestSchema.parse(await readJson(request, signal))
            if (body.agentId !== agentId) throw new DesktopHttpError(409, 'These attachments belong to another coworker.')
            const scope = { agentId, tabUid: body.tabUid, ...(body.sessionId ? { sessionId: body.sessionId } : {}), ...(body.questionId ? { questionId: body.questionId } : {}) }
            switch (body.operation) {
                case 'upload': {
                    const { operation: _operation, audioBase64, ...input } = body
                    return Response.json({ attachment: await service.upload(scope, input, decode(audioBase64), signal) }, { headers })
                }
                case 'convert': return Response.json({ attachment: await service.convert(scope, { attachmentId: body.attachmentId, expectedRevision: body.expectedRevision }, signal) }, { headers })
                case 'discard': await service.discard(scope, { attachmentId: body.attachmentId, expectedRevision: body.expectedRevision }, signal); return Response.json({ discarded: true }, { headers })
                case 'detach': await service.detach(scope, { attachmentId: body.attachmentId, expectedRevision: body.expectedRevision }, signal); return Response.json({ detached: true }, { headers })
                case 'admission': return Response.json(await service.admission(scope, { admissionId: body.admissionId, attachmentIds: body.attachmentIds, ...(body.modelChoice && { modelChoice: body.modelChoice }) }, signal), { headers })
                case 'consume': await service.consume(scope, body.admissionId, signal); return Response.json({ consumed: true }, { headers })
                case 'cancel-upload': await service.cancelUpload(scope, body.attachmentId, signal); return Response.json({ cancelled: true }, { headers })
            }
        } catch (error) {
            if (error instanceof DesktopHttpError) throw error
            if (signal.aborted) throw new DesktopHttpError(499, 'Document request was cancelled. Restore the attachment before retrying.')
            if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DesktopHttpError(400, 'Document request was not understood.')
            throw new DesktopHttpError(502, 'Document request did not finish. Restore the same attempt before retrying.')
        }
    }
}
/**
 * The streamed upload of one file above the document limit, for the kinds that are saved into the
 * coworker's Files. The body is the file's bytes and nothing else: what it is comes in one header.
 * The declared length is refused before the body is read, and must match the header and the bytes.
 */
export function desktopDocumentStagedUploadApi(service: DesktopDocumentAttachmentService) {
    return async (request: Request, agentId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
        const refuse = (status: number, message: string): never => { void request.body?.cancel().catch(() => {}); throw new DesktopHttpError(status, message) }
        try {
            if (request.method !== 'POST') return Response.json({ error: 'Method unavailable.' }, { status: 405, headers })
            const declared = request.headers.get('content-length')
            if (declared === null || !/^\d{1,12}$/.test(declared)) refuse(411, 'The upload did not say how large the file is.')
            if (Number(declared) > DESKTOP_DOCUMENT_STAGED_MAX_BYTES) refuse(413, desktopStagedUploadLimitMessage())
            const header = request.headers.get(DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER)
            if (!header || header.length > 8192) refuse(400, 'Document request was not understood.')
            let input: ReturnType<typeof desktopDocumentStagedUploadSchema.parse>
            try { input = desktopDocumentStagedUploadSchema.parse(JSON.parse(decodeURIComponent(header!))) }
            catch { return refuse(400, 'Document request was not understood.') }
            if (input.agentId !== agentId) refuse(409, 'These attachments belong to another coworker.')
            if (input.byteLength !== Number(declared)) refuse(400, 'The upload size did not match the file size.')
            if (!request.body) refuse(400, 'Missing document request body.')
            const scope = { agentId, tabUid: input.tabUid, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.questionId ? { questionId: input.questionId } : {}) }
            return Response.json({ attachment: await service.uploadStaged(scope, input, request.body!, signal) }, { headers })
        } catch (error) {
            if (error instanceof DesktopHttpError) throw error
            if (signal.aborted) throw new DesktopHttpError(499, 'The upload was cancelled or took too long. Nothing was attached.')
            if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DesktopHttpError(400, 'Document request was not understood.')
            throw new DesktopHttpError(502, 'The upload did not finish. Retry the same file.')
        }
    }
}
export function desktopDocumentAttachmentHandlers(service: DesktopDocumentAttachmentService) {
    const api = desktopDocumentAttachmentsApi(service)
    const handler = (request: Request, context: { params: Promise<{ agentId: string }> }) => desktopRoute(request, async () => api(request, (await context.params).agentId))
    return { GET: handler, POST: handler }
}
