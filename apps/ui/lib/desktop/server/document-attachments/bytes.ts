import { createHash } from 'node:crypto'
import { DESKTOP_DOCUMENT_IMAGE_MAX_BYTES, DESKTOP_DOCUMENT_INPUT_MAX_BYTES, DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_MAX_BYTES, desktopDocumentKindForName, isDesktopStagedDocumentKind, isDesktopTextLikeDocumentName, type DesktopDocumentKind } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { desktopImageKindForName, type DesktopImageKind } from '../../composer-image'
import { desktopAudioKind, inspectDesktopAudioBytes } from '../audio-bytes'
import { inspectDesktopPdfBytes } from '../pdf-bytes'
import { desktopVideoKind, inspectDesktopVideoBytes } from '../video-bytes'

export { desktopDocumentKindForName } from '@rerun/contracts'

const imageTypes: Record<DesktopImageKind, readonly [string, ...string[]]> = {
    png: ['image/png'], jpeg: ['image/jpeg'], webp: ['image/webp'], gif: ['image/gif'],
    avif: ['image/avif'], ico: ['image/x-icon', 'image/vnd.microsoft.icon'],
    bmp: ['image/bmp', 'image/x-ms-bmp'], svg: ['image/svg+xml'],
}

// A source, data or config name becomes model text only when its bytes are bounded UTF-8 without
// control bytes. Anything else under that name keeps the download-only binary rules, and a record
// saved as binary before this reader existed is never reclassified.
function textLikeDocument(input: { name: string; kind?: DesktopDocumentKind }, bytes: Uint8Array): boolean {
    if (input.kind === 'binary' || !isDesktopTextLikeDocumentName(input.name) || bytes.byteLength > DESKTOP_DOCUMENT_INPUT_MAX_BYTES) return false
    if (bytes.some(byte => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) return false
    try { readDesktopPlainText(bytes); return true }
    catch { return false }
}

function assertDocumentNameAndType(input: { name: string; mimeType: string }) {
    if (!input.name || new TextEncoder().encode(input.name).length > 255 || input.name.includes('/') || input.name.includes('\\') || input.name.includes('\0') || input.name.startsWith('.') || /\p{Cc}/u.test(input.name)) {
        throw new DesktopHttpError(400, 'That file name can’t be imported.')
    }
    if (!input.mimeType || input.mimeType.length > 128 || /[\r\n\0]/.test(input.mimeType)) throw new DesktopHttpError(400, 'That file type is invalid.')
}

const videoType = (name: string, mimeType: string, bytes: Uint8Array, maxBytes?: number) => {
    const inspected = inspectDesktopVideoBytes(desktopVideoKind(name)!, bytes, maxBytes)
    if (![inspected.contentType, 'application/octet-stream'].includes(mimeType.toLowerCase())) throw new DesktopHttpError(400, 'Video type does not match its contents.')
    return inspected.contentType
}
const assertBinaryType = (mimeType: string) => {
    if (/^(?:application\/pdf|audio\/|video\/)/i.test(mimeType)) throw new DesktopHttpError(400, 'This media type is not supported by the desktop readers.')
}

/** The name and declared type of a file above the document limit, before any byte is read. Only
 * the kinds that are saved into Files may be this large; every other kind keeps its own limit. */
export function inspectDesktopLargeUploadName(input: { name: string; mimeType: string; byteLength: number }): { kind: 'video' | 'binary' } {
    assertDocumentNameAndType(input)
    const kind = desktopDocumentKindForName(input.name)
    if (kind === 'image') throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
    if (!isDesktopStagedDocumentKind(kind)) throw new DesktopHttpError(413, 'Documents can be up to 16 MB.')
    if (input.byteLength > DESKTOP_DOCUMENT_STAGED_MAX_BYTES) throw new DesktopHttpError(413, `Files saved to a coworker’s Files can be up to ${DESKTOP_DOCUMENT_STAGED_MAX_BYTES / 1024 / 1024} MB.`)
    if (kind === 'binary') assertBinaryType(input.mimeType)
    return { kind: kind as 'video' | 'binary' }
}

/** The same structure and type check a small video gets. `bytes` is the upload's one in-memory copy. */
export function inspectDesktopLargeVideo(input: { name: string; mimeType: string }, bytes: Uint8Array): string {
    try { return videoType(input.name, input.mimeType, bytes, DESKTOP_DOCUMENT_STAGED_MAX_BYTES) }
    catch (error) {
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(415, 'This video could not be checked: it is damaged, is not the format its name says, or has too many parts. It was not attached.')
    }
}

export function inspectDesktopDocumentUpload(input: { name: string; mimeType: string; kind?: DesktopDocumentKind }, bytes: Uint8Array) {
    assertDocumentNameAndType(input)
    if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_DOCUMENT_MAX_BYTES) throw new DesktopHttpError(413, 'Documents can be up to 16 MB.')
    const named = desktopDocumentKindForName(input.name)
    const kind: DesktopDocumentKind = named === 'binary' && textLikeDocument(input, bytes) ? 'text' : named
    let mimeType = input.mimeType
    if (kind === 'image') {
        if (bytes.byteLength > DESKTOP_DOCUMENT_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
        const types = imageTypes[desktopImageKindForName(input.name)!]
        if (!types.includes(input.mimeType.toLowerCase()) && input.mimeType !== 'application/octet-stream') throw new DesktopHttpError(415, 'Image type does not match its contents.')
        mimeType = types[0]
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
        mimeType = videoType(input.name, input.mimeType, bytes)
    } else assertBinaryType(input.mimeType)
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

/** The audio a configured transcription service is sent: every inspected Files audio format, up to 8 MB. */
export function desktopAudioTranscribable(attachment: { name: string; byteLength: number }): boolean {
    return attachment.byteLength >= 1 && attachment.byteLength <= 8 * 1024 * 1024 && /\.(?:wav|mp3|m4a|ogg|flac)$/i.test(attachment.name)
}
