import 'server-only'
import { createHash } from 'node:crypto'
import { DesktopHttpError } from '../auth'
import { desktopRasterKind } from '../image-bytes'
import { inspectDesktopPreviewImageBytes } from '../animated-image'
import { convertRasterPreviewImage } from '../preview-raster-formats'
import { rasterizeDesktopSvg } from '../preview-svg'
import { desktopAudioKind, inspectDesktopAudioBytes } from '../audio-bytes'
import { desktopVideoKind, inspectDesktopVideoBytes } from '../video-bytes'
import { inspectDesktopPdfBytes } from '../pdf-bytes'
import { renderDesktopPdf } from '../pdf-render'

export async function previewResultBytes(name: string, bytes: Uint8Array, options: { signal: AbortSignal; page?: number; scale?: number }): Promise<Response> {
    options.signal.throwIfAborted()
    if (bytes.byteLength > 16 * 1024 * 1024) throw new DesktopHttpError(413, 'This file is too large to preview.')
    const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin' })
    let body = bytes
    try {
        const image = desktopRasterKind(name), audio = desktopAudioKind(name), video = desktopVideoKind(name)
        const extension = name.split('.').at(-1)?.toLowerCase()
        if (image || ['svg', 'avif', 'ico', 'bmp'].includes(extension ?? '')) {
            if (bytes.byteLength > 8 * 1024 * 1024) throw new DesktopHttpError(413, 'This image is too large to preview.')
            const display = image ? { ...inspectDesktopPreviewImageBytes(image, bytes), bytes }
                : extension === 'svg' ? await rasterizeDesktopSvg(bytes, options.signal)
                : await convertRasterPreviewImage(bytes, extension!, options.signal)
            body = display.bytes
            headers.set('content-type', display.contentType)
            headers.set('x-image-width', String(display.width))
            headers.set('x-image-height', String(display.height))
            headers.set('x-rerun-preview-kind', 'image')
        } else if (audio || video) {
            const inspected = audio ? inspectDesktopAudioBytes(audio, bytes) : inspectDesktopVideoBytes(video!, bytes)
            headers.set('content-type', inspected.contentType)
            headers.set('x-rerun-preview-kind', audio ? 'audio' : 'video')
        } else if (extension === 'pdf') {
            inspectDesktopPdfBytes('pdf', bytes)
            const raster = await renderDesktopPdf(bytes, options)
            body = raster.png
            headers.set('content-type', 'image/png')
            headers.set('x-rerun-preview-kind', 'pdf')
            for (const [key, value] of Object.entries({ page: raster.page, pages: raster.pageCount, width: raster.width, height: raster.height,
                'page-width': raster.pageWidth, 'page-height': raster.pageHeight, sha256: createHash('sha256').update(bytes).digest('hex') })) headers.set(`x-pdf-${key}`, String(value))
        } else if (extension === 'txt' || extension === 'md') {
            if (bytes.byteLength > 32 * 1024) throw new DesktopHttpError(413, 'This text file is too large to preview.')
            new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            headers.set('content-type', 'text/plain; charset=utf-8')
            headers.set('x-rerun-preview-kind', 'text')
        } else throw new DesktopHttpError(415, 'No preview is available for this file type.')
    } catch (error) {
        options.signal.throwIfAborted()
        if (error instanceof DesktopHttpError) throw error
        throw new DesktopHttpError(415, 'This file is damaged or uses a format that cannot be previewed.')
    }
    options.signal.throwIfAborted()
    headers.set('content-length', String(body.byteLength))
    return new Response(new Uint8Array(body), { headers })
}
