import { createHash } from 'node:crypto'
import { DESKTOP_DOCUMENT_IMAGE_MAX_BYTES, DESKTOP_DOCUMENT_INPUT_MAX_BYTES, DESKTOP_DOCUMENT_MAX_BYTES, desktopDocumentKindForName } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { desktopAudioKind, inspectDesktopAudioBytes } from '../audio-bytes'
import { inspectDesktopPdfBytes } from '../pdf-bytes'
import { desktopVideoKind, inspectDesktopVideoBytes } from '../video-bytes'

export { desktopDocumentKindForName } from '@rerun/contracts'

export function inspectDesktopDocumentUpload(input: { name: string; mimeType: string }, bytes: Uint8Array) {
    if (!input.name || new TextEncoder().encode(input.name).length > 255 || input.name.includes('/') || input.name.includes('\\') || input.name.includes('\0') || input.name.startsWith('.') || /\p{Cc}/u.test(input.name)) {
        throw new DesktopHttpError(400, 'That file name can’t be imported.')
    }
    if (!input.mimeType || input.mimeType.length > 128 || /[\r\n\0]/.test(input.mimeType)) throw new DesktopHttpError(400, 'That file type is invalid.')
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_DOCUMENT_MAX_BYTES) throw new DesktopHttpError(413, 'Documents can be up to 16 MB.')
    const kind = desktopDocumentKindForName(input.name)
    let mimeType = input.mimeType
    if (kind === 'image') {
        if (bytes.byteLength > DESKTOP_DOCUMENT_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
        const extension = input.name.split('.').at(-1)!.toLowerCase()
        mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg'
        if (input.mimeType !== mimeType && input.mimeType !== 'application/octet-stream') throw new DesktopHttpError(415, 'Image type does not match its contents.')
    } else if (kind === 'text') {
        // Never serve a browser-supplied active media type for these UTF-8 documents.
        readDesktopPlainText(bytes)
        mimeType = 'text/plain'
    } else if (kind === 'pdf') {
        if (!['application/pdf', 'application/octet-stream', ''].includes(input.mimeType)) throw new DesktopHttpError(400, 'PDF type does not match its contents.')
        mimeType = inspectDesktopPdfBytes('pdf', bytes).contentType
    } else if (kind === 'audio') {
        const inspected = inspectDesktopAudioBytes(desktopAudioKind(input.name)!, bytes)
        const aliases = inspected.contentType === 'audio/mp4' ? ['audio/x-m4a', 'audio/m4a'] : inspected.contentType === 'audio/wav' ? ['audio/x-wav', 'audio/wave'] : inspected.contentType === 'audio/mpeg' ? ['audio/mp3'] : []
        if (![inspected.contentType, 'application/octet-stream', ...aliases].includes(input.mimeType.toLowerCase())) throw new DesktopHttpError(400, 'Audio type does not match its contents.')
        mimeType = inspected.contentType
    } else if (kind === 'video') {
        const inspected = inspectDesktopVideoBytes(desktopVideoKind(input.name)!, bytes)
        if (![inspected.contentType, 'application/octet-stream'].includes(input.mimeType.toLowerCase())) throw new DesktopHttpError(400, 'Video type does not match its contents.')
        mimeType = inspected.contentType
    } else if (/^(?:application\/pdf|audio\/|video\/)/i.test(input.mimeType)) {
        throw new DesktopHttpError(400, 'This media type is not supported by the desktop readers.')
    }
    return { kind, mimeType, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength }
}

export function readDesktopPlainText(bytes: Uint8Array): string {
    if (bytes.byteLength > DESKTOP_DOCUMENT_INPUT_MAX_BYTES) throw new DesktopHttpError(413, 'Text attachments can be up to 128 KiB.')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new DesktopHttpError(400, 'Choose a UTF-8 text file.') }
    if (!text.trim() || text.includes('\0')) throw new DesktopHttpError(400, 'Choose a non-empty UTF-8 text file.')
    return text
}
