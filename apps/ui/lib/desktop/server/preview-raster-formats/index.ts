import 'server-only'
import type { Sharp } from 'sharp'
import { DESKTOP_IMAGE_MAX_BYTES, DESKTOP_IMAGE_MAX_PIXELS, inspectDesktopImageBytes } from '../image-bytes'
import { inspectAvif } from './avif'
import { decodeBitmap, inspectBitmap, type BitmapPlan } from './bitmap'
import { inspectIcon, type IconFrame } from './ico'
import { checkInput, checkOpen, fail, formatOf, RasterPreviewError, type RasterPreviewDisplay, type RasterPreviewInspection } from './common'

export { RasterPreviewError } from './common'
export type { RasterPreviewDisplay, RasterPreviewFormat, RasterPreviewInspection, RasterPreviewReason } from './common'
export const RASTER_PREVIEW_DEADLINE_MS = 5_000

type Plan = { info: RasterPreviewInspection; bitmap?: BitmapPlan; frame?: IconFrame }
function inspect(bytes: Uint8Array, extension: string, signal: AbortSignal): Plan {
    checkInput(bytes, signal)
    const format = formatOf(extension)
    if (format === 'avif') {
        const size = inspectAvif(bytes, signal)
        return { info: { format, ...size, frames: 1, animated: false, sourceFrames: 1 } }
    }
    if (format === 'bmp') {
        const bitmap = inspectBitmap(bytes)
        return { bitmap, info: { format, width: bitmap.width, height: bitmap.height, aggregatePixels: bitmap.width * bitmap.height, frames: 1, animated: false, sourceFrames: 1 } }
    }
    const icon = inspectIcon(bytes, signal), selected = icon.selected
    return { frame: selected, info: { format, width: selected.width, height: selected.height, aggregatePixels: icon.aggregatePixels, selectedFrame: selected.index, frames: 1, animated: false, sourceFrames: icon.frames.length } }
}
export function inspectRasterPreviewImage(bytes: Uint8Array, extension: string, signal: AbortSignal): RasterPreviewInspection {
    const result = inspect(bytes, extension, signal).info
    checkOpen(signal)
    return result
}
async function guarded<T>(pipeline: Sharp, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    let abort: () => void = () => {}
    try {
        checkOpen(signal)
        return await new Promise<T>((resolve, reject) => {
            abort = () => { pipeline.destroy(); reject(new RasterPreviewError('aborted')) }
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) { abort(); return }
            void Promise.resolve().then(() => { checkOpen(signal); return action() }).then(value => { if (signal.aborted) abort(); else resolve(value) }, () => reject(new RasterPreviewError(signal.aborted ? 'aborted' : 'corrupt')))
        })
    } finally { signal.removeEventListener('abort', abort); pipeline.destroy() }
}
export async function convertRasterPreviewImage(input: Uint8Array, extension: string, callerSignal: AbortSignal): Promise<RasterPreviewDisplay> {
    checkInput(input, callerSignal)
    const bytes = new Uint8Array(input)
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), RASTER_PREVIEW_DEADLINE_MS)
    const signal = AbortSignal.any([callerSignal, deadline.signal])
    try {
        const plan = inspect(bytes, extension, signal), info = plan.info
        let sharp: typeof import('sharp').default
        try { sharp = (await import('sharp')).default } catch { fail('dependency') }
        checkOpen(signal)
        const options = { limitInputPixels: DESKTOP_IMAGE_MAX_PIXELS, limitInputChannels: 4, unlimited: false, failOn: 'warning' as const, sequentialRead: true, ignoreIcc: true }
        let rgba: Uint8Array
        const bitmap = plan.bitmap ?? plan.frame?.bitmap
        if (bitmap) rgba = await decodeBitmap(plan.frame?.bytes ?? bytes, bitmap, signal)
        else {
            const source = Buffer.from(plan.frame?.bytes ?? bytes)
            const probe = sharp(source, { ...options, pages: 1, page: 0 }).timeout({ seconds: 3 })
            const metadata = await guarded(probe, signal, () => probe.metadata())
            // Metadata and pixels use independent bounded pipelines; neither is a filesystem path.
            if (metadata.width !== info.width || metadata.height !== info.height || (metadata.pages !== undefined && metadata.pages !== 1) || (metadata.pageHeight !== undefined && metadata.pageHeight !== info.height)) fail('corrupt')
            if (metadata.delay?.length || metadata.loop !== undefined) fail('animation')
            if (info.format === 'avif' ? metadata.format !== 'heif' || metadata.compression !== 'av1' : metadata.format !== 'png') fail('mismatch')
            const decoder = sharp(source, { ...options, pages: 1, page: 0 }).timeout({ seconds: 3 }).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
            const decoded = await guarded(decoder, signal, () => decoder.toBuffer({ resolveWithObject: true }))
            if (decoded.info.width !== info.width || decoded.info.height !== info.height || decoded.info.channels !== 4 || decoded.data.length !== info.width * info.height * 4) fail('corrupt')
            rgba = decoded.data
        }
        checkOpen(signal)
        if (rgba.length !== info.width * info.height * 4) fail('corrupt')
        const encoder = sharp(Buffer.from(rgba), { ...options, raw: { width: info.width, height: info.height, channels: 4 } }).timeout({ seconds: 3 }).png({ compressionLevel: 6, progressive: false, palette: false })
        const encoded = await guarded(encoder, signal, () => encoder.toBuffer({ resolveWithObject: true }))
        checkOpen(signal)
        if (!encoded.data.length || encoded.data.length > DESKTOP_IMAGE_MAX_BYTES) fail('output')
        const size = inspectDesktopImageBytes('png', encoded.data)
        if (size.width !== info.width || size.height !== info.height || encoded.info.width !== info.width || encoded.info.height !== info.height || encoded.info.format !== 'png') fail('corrupt')
        return { ...info, contentType: 'image/png', bytes: new Uint8Array(encoded.data) }
    } catch (error) {
        if (callerSignal.aborted) fail('aborted')
        if (deadline.signal.aborted) fail('unsupported')
        if (error instanceof RasterPreviewError) throw error
        fail('corrupt')
    } finally { clearTimeout(timer) }
}

export function rasterPreviewFailure(error: unknown): { status: number; message: string } {
    const reason = error instanceof RasterPreviewError ? error.reason : 'corrupt'
    if (reason === 'aborted') return { status: 499, message: 'Image preview was closed.' }
    if (reason === 'dimensions' || reason === 'frames' || reason === 'output') return { status: 413, message: 'This image is too large to preview.' }
    if (reason === 'animation') return { status: 415, message: 'Animated AVIF or animated icon images cannot be previewed.' }
    if (reason === 'unsupported') return { status: 415, message: 'This image uses an unsupported raster layout or exceeded the preview deadline.' }
    if (reason === 'dependency') return { status: 503, message: 'The raster preview decoder is unavailable.' }
    return { status: 415, message: 'This image is damaged or does not match its file extension.' }
}
