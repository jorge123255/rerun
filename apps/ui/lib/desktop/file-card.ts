import { inspectCardImageResponse } from './image-card-response'
import {
    CARD_MAX_AUDIO_BYTES, CARD_MAX_FILES, CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES, CARD_MAX_VIDEO_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES,
    fileCardSchema, isDesktopAttachmentPath, type FileCard, type FileCardEntry,
} from '@rerun/contracts'

// A Mac result card points at one of this coworker's visible persistent files. The engine wrote
// these fields, but a saved tool result is still untrusted input to the renderer: accept only the
// small card shape and only paths an authenticated desktop route can open.
const hiddenSegment = (path: string) => path.split('/').some(segment => segment.startsWith('.'))
const visiblePath = (path: string) => path.length <= 4096 && !/[\\\p{Cc}]/u.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'))
const textPath = (path: string) => isDesktopAttachmentPath(path) && !path.includes('\\') && !hiddenSegment(path)
const CARD_IMAGE = /\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i
const CARD_AUDIO = /\.(?:wav|mp3|m4a|ogg|flac)$/i
const CARD_VIDEO = /\.(?:mp4|webm|mov|m4v)$/i
const CARD_PDF = /\.pdf$/i
/** Matches DESKTOP_PDF_MAX_BYTES. The shared card contract is unchanged, so the cap stays local. */
export const DESKTOP_CARD_PDF_MAX_BYTES = 16 * 1024 * 1024
const imagePath = (path: string) => visiblePath(path) && CARD_IMAGE.test(path)
const audioPath = (path: string) => visiblePath(path) && CARD_AUDIO.test(path)
const videoPath = (path: string) => visiblePath(path) && CARD_VIDEO.test(path)
const pdfPath = (path: string) => visiblePath(path) && CARD_PDF.test(path)
const validName = (name: string) => name.length > 0 && name.length <= 255 && !/[\\/\p{Cc}]/u.test(name)
const CARD_IDENTITY = /^\d{1,24}:\d{1,24}$/
const AUDIO_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime'])

/** A card's file is an image (not a document) when its path names a supported bounded image. */
export function isDesktopCardImage(path: string): boolean {
    return imagePath(path)
}

/** A card's file is audio when its path names a supported Files audio format. */
export function isDesktopCardAudio(path: string): boolean {
    return audioPath(path)
}

/** A card's file is video when its path names a supported Files video. */
export function isDesktopCardVideo(path: string): boolean {
    return videoPath(path)
}

/** A card's file is a PDF document tile, never an image or video album entry. */
export function isDesktopCardPdf(path: string): boolean {
    return pdfPath(path)
}

function candidate(value: unknown, depth = 0): unknown {
    if (depth > 2) return undefined
    if (typeof value === 'string') {
        try { return candidate(JSON.parse(value), depth + 1) }
        catch { return undefined }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const wrapper = value as { type?: unknown; value?: unknown }
        if (wrapper.type === 'json' && 'value' in wrapper) return candidate(wrapper.value, depth + 1)
        if (wrapper.type === 'text' && typeof wrapper.value === 'string') return candidate(wrapper.value, depth + 1)
    }
    return value
}

/**
 * Validate one recorded card_file result for the Mac conversation. It accepts the live tool output
 * (a JSON string), a stored text/json wrapper, a parsed card, and the legacy single-file card. Every
 * file must still look like a visible reference of this coworker: a .txt/.md document, a PDF, a bounded
 * PNG/JPEG/WebP/GIF/SVG/AVIF/ICO/BMP image, a WAV/MP3/M4A/Ogg/FLAC audio file, or an MP4/WebM/MOV/M4V video. Images and videos share the
 * endpoint identity and the 24 MiB combined preview budget; images stay 8 MiB, video 16 MiB, audio
 * 16 MiB, and each PDF 16 MiB. PDFs carry the same identity and do not join that budget. Text keeps
 * its 32 KiB bound. Anything else returns undefined so the reply can fall back to the real tool
 * result instead of drawing a fabricated, replaced or partial card.
 */
export function desktopFileCardOf(value: unknown): FileCard | undefined {
    const parsed = fileCardSchema.safeParse(candidate(value))
    if (!parsed.success) return undefined
    const { files } = parsed.data
    if (files.length < 1 || files.length > CARD_MAX_FILES) return undefined
    const normalized: FileCardEntry[] = []
    let mediaBytes = 0
    for (const file of files) {
        if (file.scope !== 'agent') return undefined
        if (!validName(file.name) || file.name !== file.path.split('/').at(-1)) return undefined
        if (!Number.isSafeInteger(file.size) || file.size < 0) return undefined
        if (imagePath(file.path)) {
            if (file.size === 0 || file.size > CARD_MAX_IMAGE_BYTES) return undefined
            if (!file.identity || !CARD_IDENTITY.test(file.identity)) return undefined
            mediaBytes += file.size
            if (mediaBytes > CARD_MAX_IMAGE_TOTAL_BYTES) return undefined
            normalized.push({ path: file.path, name: file.name, size: file.size, scope: 'agent', identity: file.identity })
        } else if (videoPath(file.path)) {
            if (file.size === 0 || file.size > CARD_MAX_VIDEO_BYTES) return undefined
            if (!file.identity || !CARD_IDENTITY.test(file.identity)) return undefined
            mediaBytes += file.size
            if (mediaBytes > CARD_MAX_IMAGE_TOTAL_BYTES) return undefined
            normalized.push({ path: file.path, name: file.name, size: file.size, scope: 'agent', identity: file.identity })
        } else if (audioPath(file.path)) {
            if (file.size === 0 || file.size > CARD_MAX_AUDIO_BYTES) return undefined
            if (!file.identity || !CARD_IDENTITY.test(file.identity)) return undefined
            normalized.push({ path: file.path, name: file.name, size: file.size, scope: 'agent', identity: file.identity })
        } else if (pdfPath(file.path)) {
            if (file.size === 0 || file.size > DESKTOP_CARD_PDF_MAX_BYTES) return undefined
            if (!file.identity || !CARD_IDENTITY.test(file.identity)) return undefined
            normalized.push({ path: file.path, name: file.name, size: file.size, scope: 'agent', identity: file.identity })
        } else if (textPath(file.path)) {
            if (file.size > DESKTOP_ATTACHMENT_MAX_BYTES) return undefined
            normalized.push({ path: file.path, name: file.name, size: file.size, scope: 'agent' })
        } else return undefined
    }
    return { kind: 'file', files: normalized }
}

/** A route or validation error safe to show in the card's preview. */
export class DesktopCardError extends Error {}

/** Same-origin PDF page route for one opened card. The page renderer adds page and scale. This does not fetch. */
export function desktopCardPdfSrc(agentId: string, path: string, identity: string | undefined): string {
    if (!pdfPath(path)) throw new DesktopCardError('This file is not a supported PDF.')
    if (!identity || !CARD_IDENTITY.test(identity)) throw new DesktopCardError('Send this PDF to preview again.')
    const query = new URLSearchParams({ path, identity })
    return `/api/desktop/agents/${encodeURIComponent(agentId)}/files/pdf?${query}`
}

/** Read a card's text through the authenticated desktop Files route, at the moment it is opened. */
export async function readDesktopCardFile(agentId: string, path: string, signal?: AbortSignal): Promise<{ content: string; truncated: boolean }> {
    const query = new URLSearchParams({ path })
    const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/files/read?${query.toString()}`, { cache: 'no-store', ...(signal && { signal }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new DesktopCardError(typeof body?.error === 'string' ? body.error : 'This file is no longer available.')
    if (typeof body?.content !== 'string') throw new DesktopCardError('This file is no longer available.')
    return { content: body.content, truncated: body.truncated === true }
}

/** Read a card's current image through the authenticated desktop Files image route. */
export async function readDesktopCardImage(agentId: string, path: string, identity: string | undefined, signal?: AbortSignal): Promise<import('./image-card-response').CardImageDisplay> {
    if (!imagePath(path)) throw new DesktopCardError('This file is not a supported image.')
    if (!identity || !CARD_IDENTITY.test(identity)) throw new DesktopCardError('Send this image to preview again.')
    const query = new URLSearchParams({ path, identity, animation: '1' })
    const deadline = AbortSignal.timeout(5_000)
    const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/files/image?${query}`, { cache: 'no-store', signal: boundedSignal })
    if (!response.ok) throw new DesktopCardError('This image is no longer available.')
    try { return await inspectCardImageResponse(response, path, boundedSignal) }
    catch { signal?.throwIfAborted(); throw new DesktopCardError('This image can’t be displayed.') }
}


/** Read a card's current audio through the authenticated desktop Files audio route. */
export async function readDesktopCardAudio(agentId: string, path: string, identity: string | undefined, signal?: AbortSignal): Promise<{ blob: Blob; contentType: string }> {
    if (!audioPath(path)) throw new DesktopCardError('This file is not a supported audio file.')
    if (!identity || !CARD_IDENTITY.test(identity)) throw new DesktopCardError('Send this audio to preview again.')
    const query = new URLSearchParams({ path, identity })
    const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/files/audio?${query.toString()}`, { cache: 'no-store', ...(signal && { signal }) })
    if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new DesktopCardError(typeof body?.error === 'string' ? body.error : 'This audio is no longer available.')
    }
    const blob = await response.blob()
    const contentType = (response.headers.get('content-type') ?? blob.type).split(';')[0]!.trim().toLowerCase()
    if (!AUDIO_TYPES.has(contentType) || blob.size < 1 || blob.size > CARD_MAX_AUDIO_BYTES) {
        throw new DesktopCardError('This audio file can’t be played.')
    }
    return { blob, contentType }
}

/** Read a card's current video through the authenticated desktop Files video route. */
export async function readDesktopCardVideo(agentId: string, path: string, identity: string | undefined, signal?: AbortSignal): Promise<{ blob: Blob; contentType: string }> {
    if (!videoPath(path)) throw new DesktopCardError('This file is not a supported video.')
    if (!identity || !CARD_IDENTITY.test(identity)) throw new DesktopCardError('Send this video to preview again.')
    const query = new URLSearchParams({ path, identity })
    const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/files/video?${query.toString()}`, { cache: 'no-store', ...(signal && { signal }) })
    if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new DesktopCardError(typeof body?.error === 'string' ? body.error : 'This video is no longer available.')
    }
    const blob = await response.blob()
    const contentType = (response.headers.get('content-type') ?? blob.type).split(';')[0]!.trim().toLowerCase()
    if (!VIDEO_TYPES.has(contentType) || blob.size < 1 || blob.size > CARD_MAX_VIDEO_BYTES) {
        throw new DesktopCardError('This video can’t be played.')
    }
    return { blob, contentType }
}
