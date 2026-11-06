'use client'
import { z } from 'zod'
import { DESKTOP_DOCUMENT_MAX_BYTES, desktopDocumentAdmissionSchema, desktopDocumentAttachmentSchema, type DesktopDocumentScope, type DesktopDocumentAttachment, type DesktopDocumentSelection, type DesktopDocumentReference } from '@rerun/contracts'

const endpoint = (agentId: string) => `/api/desktop/coworkers/${encodeURIComponent(agentId)}/document-attachments`
export async function readDocumentResponse(response: Response, cap: number, signal?: AbortSignal): Promise<Uint8Array> {
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) { await response.body?.cancel(); throw new Error('Attachment response exceeds its limit.') }
    if (!response.body) throw new Error('Attachment response is empty.')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let count = 0
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
        while (true) {
            signal?.throwIfAborted(); const part = await reader.read(); signal?.throwIfAborted()
            if (part.done) break
            count += part.value.byteLength
            if (count > cap) throw new Error('Attachment response exceeds its limit.')
            chunks.push(part.value)
        }
        if (length !== null && count !== Number(length)) throw new Error('Attachment response was interrupted.')
        const bytes = new Uint8Array(count); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        return bytes
    } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}) }
}
async function request(agentId: string, init: RequestInit, query?: URLSearchParams): Promise<unknown> {
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)])
    const response = await fetch(`${endpoint(agentId)}${query ? `?${query}` : ''}`, { cache: 'no-store', redirect: 'error', credentials: 'same-origin', ...init, signal })
    const bytes = await readDocumentResponse(response, response.ok ? 6 * 1024 * 1024 : 16_384, signal)
    let body: unknown
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('Attachment reply was not understood.') }
    if (!response.ok) throw new Error(typeof (body as { error?: unknown })?.error === 'string' ? (body as { error: string }).error : 'Attachment request did not finish.')
    return body
}
function owned(scope: DesktopDocumentScope, value: unknown, id?: string, alias = false): DesktopDocumentAttachment {
    const a = desktopDocumentAttachmentSchema.parse(value)
    if (a.scope.agentId !== scope.agentId || a.scope.tabUid !== scope.tabUid || a.scope.sessionId !== scope.sessionId && !(alias && scope.sessionId !== undefined && a.scope.sessionId === undefined) || id && a.attachmentId !== id) throw new Error('This attachment belongs to another conversation.')
    return a
}
const post = (scope: DesktopDocumentScope, body: object, signal?: AbortSignal) => request(scope.agentId, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...scope, ...body }), signal })
export async function uploadDesktopDocument(scope: DesktopDocumentScope, id: string, file: File, signal?: AbortSignal, position = 0) {
    signal?.throwIfAborted()
    if (!file.size || file.size > DESKTOP_DOCUMENT_MAX_BYTES) throw new Error('Choose a non-empty attachment up to 16 MB.')
    const bytes = new Uint8Array(await file.arrayBuffer()); signal?.throwIfAborted()
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    const result = z.object({ attachment: desktopDocumentAttachmentSchema }).parse(await post(scope, { operation: 'upload', attachmentId: id, name: file.name, mimeType: file.type || 'application/octet-stream', position, audioBase64: btoa(binary) }, signal))
    return owned(scope, result.attachment, id)
}
export async function listDesktopDocuments(scope: DesktopDocumentScope, signal?: AbortSignal) {
    const query = new URLSearchParams({ tabUid: scope.tabUid, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) })
    return z.object({ attachments: z.array(desktopDocumentAttachmentSchema).max(10) }).parse(await request(scope.agentId, { signal }, query)).attachments.map(a => owned(scope, a, undefined, true))
}
export async function convertDesktopDocument(scope: DesktopDocumentScope, attachmentId: string, expectedRevision: string, signal?: AbortSignal) {
    const result = z.object({ attachment: desktopDocumentAttachmentSchema }).parse(await post(scope, { operation: 'convert', attachmentId, expectedRevision }, signal))
    return owned(scope, result.attachment, attachmentId)
}
export async function discardDesktopDocument(scope: DesktopDocumentScope, attachmentId: string, expectedRevision: string, signal?: AbortSignal) { await post(scope, { operation: 'discard', attachmentId, expectedRevision }, signal) }
export async function detachDesktopDocument(scope: DesktopDocumentScope, attachmentId: string, expectedRevision: string, signal?: AbortSignal) { await post(scope, { operation: 'detach', attachmentId, expectedRevision }, signal) }
export async function admitDesktopDocuments(scope: DesktopDocumentScope, selection: DesktopDocumentSelection, signal?: AbortSignal) { return desktopDocumentAdmissionSchema.parse(await post(scope, { operation: 'admission', ...selection }, signal)) }
export async function consumeDesktopDocuments(scope: DesktopDocumentScope, admissionId: string, signal?: AbortSignal) { await post(scope, { operation: 'consume', admissionId }, signal) }
export async function cancelDesktopDocumentUpload(scope: DesktopDocumentScope, attachmentId: string, signal?: AbortSignal) { await post(scope, { operation: 'cancel-upload', attachmentId }, signal) }
export function desktopDocumentReadUrl(attachment: DesktopDocumentReference | DesktopDocumentAttachment, view: 'read' | 'preview' | 'download' = 'read', page?: number, scale?: number) {
    const query = new URLSearchParams({ tabUid: attachment.scope.tabUid, ...(attachment.scope.sessionId ? { sessionId: attachment.scope.sessionId } : {}), attachmentId: attachment.attachmentId, sha256: attachment.sha256, view, ...(page ? { page: String(page) } : {}), ...(scale ? { scale: String(scale) } : {}) })
    return `${endpoint(attachment.scope.agentId)}?${query}`
}
export async function fetchDesktopDocument(attachment: DesktopDocumentReference | DesktopDocumentAttachment, signal: AbortSignal, view: 'preview' | 'download' = 'preview', page?: number, scale?: number) {
    const response = await fetch(desktopDocumentReadUrl(attachment, view, page, scale), { cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal })
    if (!response.ok || response.headers.get('x-rerun-document-sha256') !== attachment.sha256) { await response.body?.cancel().catch(() => {}); throw new Error('This attachment is unavailable or changed.') }
    return response
}
