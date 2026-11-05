import { CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES } from '@rerun/contracts'
import { desktopRasterKind } from './server/image-bytes'
import { DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS, DESKTOP_PREVIEW_MAX_FRAMES, inspectDesktopPreviewImageBytes } from './server/animated-image'

export type CardImageDisplay = { blob: Blob; contentType: string; frames: number; pixels: number }

export async function inspectCardImageResponse(response: Response, path: string, signal?: AbortSignal): Promise<CardImageDisplay> {
    const converted = /\.(svg|avif|ico|bmp)$/i.test(path)
    const kind = converted ? 'png' : desktopRasterKind(path)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const expected = kind === 'jpeg' ? 'image/jpeg' : `image/${kind}`
    if (!kind || contentType !== expected || !response.body) {
        await response.body?.cancel().catch(() => {})
        throw new Error('Unsupported image response')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
        while (true) {
            signal?.throwIfAborted()
            const { done, value } = await reader.read()
            signal?.throwIfAborted()
            if (done) break
            size += value.byteLength
            if (size > CARD_MAX_IMAGE_BYTES) throw new Error('Image output too large')
            chunks.push(value)
        }
    } finally {
        signal?.removeEventListener('abort', cancel)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const info = inspectDesktopPreviewImageBytes(kind, bytes)
    signal?.throwIfAborted()
    return { blob: new Blob([bytes], { type: info.contentType }), contentType: info.contentType,
        frames: info.frames, pixels: Math.max(info.aggregatePixels, info.width * info.height * info.frames) }
}

export class CardDisplayBudget {
    private bytes = 0
    private frames = 0
    private pixels = 0
    add(bytes: number, frames = 0, pixels = 0): void {
        if (![bytes, frames, pixels].every(value => Number.isSafeInteger(value) && value >= 0)
            || this.bytes + bytes > CARD_MAX_IMAGE_TOTAL_BYTES
            || this.frames + frames > DESKTOP_PREVIEW_MAX_FRAMES
            || this.pixels + pixels > DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS) throw new Error('Card display budget exceeded')
        this.bytes += bytes
        this.frames += frames
        this.pixels += pixels
    }
}
