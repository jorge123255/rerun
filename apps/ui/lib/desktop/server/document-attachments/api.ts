import 'server-only'

import { z } from 'zod'
import { DESKTOP_DOCUMENT_MAX_BYTES, type DesktopDocumentScope } from '../../../../../../packages/contracts/src/desktop-document-attachments.ts'
import { DesktopHttpError } from '../auth'
import { desktopRoute } from '../http'
import type { DesktopDocumentAttachmentService } from './service'

const MAX_BODY_BYTES = Math.ceil(DESKTOP_DOCUMENT_MAX_BYTES / 3) * 4 + 100_000
const scopeInput = z.object({ tabUid: z.string().min(1).max(128), sessionId: z.string().min(1).max(200).optional() }).strict()
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error('Document request deadline exceeded'))
        signal.addEventListener('abort', onAbort, { once: true })
        work.then(value => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
        }, error => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
        })
        if (signal.aborted) onAbort()
    })
}

async function readJson(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Missing document request body.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const part = await withDeadline(reader.read(), signal)
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_BODY_BYTES) throw new DesktopHttpError(413, 'Document request exceeds its limit.')
            chunks.push(part.value)
        }
    } finally {
        await reader.cancel().catch(() => {})
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

function scopeOf(agentId: string, body: unknown): DesktopDocumentScope {
    const input = scopeInput.parse(body)
    return { agentId, ...input }
}

function decodeAudio(value: unknown): Uint8Array {
    if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new DesktopHttpError(400, 'Document bytes are invalid.')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_DOCUMENT_MAX_BYTES || bytes.toString('base64') !== value) throw new DesktopHttpError(400, 'Document bytes are invalid.')
    return new Uint8Array(bytes)
}

export function desktopDocumentAttachmentsApi(service: DesktopDocumentAttachmentService) {
    return async (request: Request, agentId: string): Promise<Response> => {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        try {
            if (request.method === 'GET') {
                const url = new URL(request.url)
                const tabUid = url.searchParams.get('tabUid')
                if (!tabUid) throw new DesktopHttpError(400, 'Choose a conversation tab.')
                const scope = scopeOf(agentId, { tabUid, sessionId: url.searchParams.get('sessionId') ?? undefined })
                const attachmentId = url.searchParams.get('attachmentId')
                if (attachmentId && url.searchParams.get('view') === 'read') {
                    const result = await withDeadline(service.read(scope, attachmentId, signal), signal)
                    return new Response(result.bytes, { headers: { ...headers, 'Content-Type': result.mimeType, 'Content-Length': String(result.bytes.byteLength) } })
                }
                return Response.json({ attachments: await withDeadline(service.list(scope, signal), signal) }, { headers })
            }
            if (request.method !== 'POST') return Response.json({ error: 'Method unavailable.' }, { status: 405, headers })
            const body = await readJson(request, signal)
            const scope = scopeOf(agentId, body)
            switch (body.operation) {
                case 'upload': {
                    const bytes = decodeAudio(body.audioBase64)
                    const input = { ...body, audioBase64: undefined }
                    return Response.json({ attachment: await withDeadline(service.upload(scope, input, bytes, signal), signal) }, { headers })
                }
                case 'convert':
                    return Response.json({ attachment: await withDeadline(service.convert(scope, body, signal), signal) }, { headers })
                case 'admission':
                    return Response.json(await withDeadline(service.admission(scope, signal), signal), { headers })
                case 'discard':
                    await withDeadline(service.discard(scope, body, signal), signal)
                    return Response.json({ discarded: true }, { headers })
                default:
                    throw new DesktopHttpError(400, 'Unknown document operation.')
            }
        } catch (error) {
            if (error instanceof DesktopHttpError) throw error
            return Response.json({ error: 'Document request failed or changed. Retry the same attempt.' }, { status: 400, headers })
        }
    }
}

export function desktopDocumentAttachmentHandlers(service: DesktopDocumentAttachmentService) {
    const api = desktopDocumentAttachmentsApi(service)
    const handler = async (request: Request, context: { params: Promise<{ agentId: string }> }) => desktopRoute(request, async () => api(request, (await context.params).agentId))
    return { GET: handler, POST: handler }
}
