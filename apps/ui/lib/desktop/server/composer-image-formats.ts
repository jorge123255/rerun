import 'server-only'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { DesktopHttpError } from './auth'
import { DESKTOP_IMAGE_MAX_BYTES, DESKTOP_IMAGE_MAX_PIXELS, DesktopImageBytesError, inspectDesktopImageBytes } from './image-bytes'
import { convertRasterPreviewImage, RasterPreviewError } from './preview-raster-formats'
import { DesktopSvgError, rasterizeDesktopSvg } from './preview-svg'
import {
    desktopImageKindForName, desktopImageKindIsConverted, desktopImageMediaType, desktopImageNameProblem,
    type DesktopImageKind, type DesktopImageMediaType,
} from '../composer-image'

export type ComposerImageSource = {
    displayName: string
    canonicalName: string
    kind: DesktopImageKind
    mediaType: DesktopImageMediaType
    bytes: Uint8Array
    width: number
    height: number
}

export type StoredComposerImage = { width: number; height: number }

const never = new AbortController().signal
const aborted = () => new DesktopHttpError(499, 'The image import was cancelled.')
const checkOpen = (signal?: AbortSignal) => { if (signal?.aborted) throw aborted() }

function inspectBytes(kind: DesktopImageKind, bytes: Uint8Array) {
    try { return inspectDesktopImageBytes(kind as 'png' | 'jpeg' | 'gif' | 'webp', bytes) }
    catch (error) { return bytesFailure(error) }
}

function bytesFailure(error: unknown): never {
    if (error instanceof DesktopImageBytesError && error.reason === 'animation') {
        throw new DesktopHttpError(415, 'Animated images can’t be attached. Choose a static image.')
    }
    if (error instanceof DesktopImageBytesError && error.reason === 'dimensions') {
        throw new DesktopHttpError(413, 'This image is too large to attach.')
    }
    throw new DesktopHttpError(415, 'This file is not a supported image.')
}

function rasterFailure(error: unknown, signal?: AbortSignal): never {
    checkOpen(signal)
    if (error instanceof DesktopHttpError) throw error
    if (error instanceof RasterPreviewError) {
        if (error.reason === 'aborted') throw aborted()
        if (error.reason === 'animation') throw new DesktopHttpError(415, 'Animated images can’t be attached. Choose a static image.')
        if (['dimensions', 'frames', 'output'].includes(error.reason)) throw new DesktopHttpError(413, 'This image is too large to attach.')
        if (error.reason === 'dependency') throw new DesktopHttpError(503, 'The image decoder is unavailable on this Mac.')
        if (error.reason === 'unsupported') throw new DesktopHttpError(415, 'This image uses an unsupported layout or took too long to convert.')
    }
    throw new DesktopHttpError(415, 'This image is damaged and can’t be attached.')
}

function svgFailure(error: unknown, signal?: AbortSignal): never {
    checkOpen(signal)
    if (error instanceof DesktopHttpError) throw error
    if (error instanceof DesktopSvgError) {
        if (['dimensions', 'complex'].includes(error.reason)) throw new DesktopHttpError(413, 'This SVG is too complex or too large to attach.')
    }
    throw new DesktopHttpError(415, 'This SVG uses features that can’t be attached. Choose a static SVG.')
}

function canonicalPngName(displayName: string): string {
    const stem = displayName.replace(/\.[^.]*$/, '') || 'image'
    const suffix = `-${randomBytes(4).toString('hex')}.png`
    let base = stem
    while (base && new TextEncoder().encode(base + suffix).length > 255) base = base.slice(0, -1)
    return `${base || 'image'}${suffix}`
}

const SHARP_OPTIONS = { animated: false, limitInputPixels: DESKTOP_IMAGE_MAX_PIXELS, unlimited: false, failOn: 'warning' as const }

async function validateStaticRaster(kind: DesktopImageKind, bytes: Uint8Array, signal?: AbortSignal) {
    checkOpen(signal)
    const inspected = inspectBytes(kind, bytes)
    try {
        const meta = await sharp(bytes, { ...SHARP_OPTIONS, pages: 1, page: 0 }).timeout({ seconds: 5 }).metadata()
        checkOpen(signal)
        if ((meta.pages ?? 1) > 1) throw new DesktopHttpError(415, 'Animated images can’t be attached. Choose a static image.')
        if (meta.width !== inspected.width || meta.height !== inspected.height || meta.format !== kind) {
            throw new DesktopHttpError(415, 'This image has inconsistent dimensions or format.')
        }
        await sharp(bytes, SHARP_OPTIONS).timeout({ seconds: 5 }).stats()
        checkOpen(signal)
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        checkOpen(signal)
        throw new DesktopHttpError(415, 'This image is damaged and can’t be attached.')
    }
    return inspected
}

async function encodeGifToPng(bytes: Uint8Array, width: number, height: number, signal?: AbortSignal): Promise<Uint8Array> {
    checkOpen(signal)
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 5_000)
    const combined = AbortSignal.any([signal ?? never, deadline.signal])
    const pipeline = sharp(Buffer.from(bytes), { ...SHARP_OPTIONS, pages: 1, page: 0, sequentialRead: true, ignoreIcc: true })
        .timeout({ seconds: 4 })
        .png({ compressionLevel: 6, progressive: false, palette: false })
    try {
        const output = await new Promise<Buffer>((resolve, reject) => {
            let settled = false
            const abort = () => { if (!settled) { settled = true; pipeline.destroy(); reject(aborted()) } }
            combined.addEventListener('abort', abort, { once: true })
            if (combined.aborted) { abort(); return }
            void pipeline.toBuffer().then(value => {
                if (settled) return
                if (combined.aborted) { abort(); return }
                settled = true
                combined.removeEventListener('abort', abort)
                resolve(value)
            }, error => {
                if (settled) return
                if (combined.aborted) { abort(); return }
                settled = true
                combined.removeEventListener('abort', abort)
                reject(error)
            })
        })
        checkOpen(signal)
        if (!output.byteLength || output.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'This image is too large to attach.')
        const inspected = inspectBytes('png', new Uint8Array(output))
        if (inspected.width !== width || inspected.height !== height) throw new DesktopHttpError(415, 'This image has inconsistent dimensions or format.')
        return new Uint8Array(output)
    } catch (error) {
        if (signal?.aborted) throw aborted()
        if (error instanceof DesktopHttpError) throw error
        if (deadline.signal.aborted) throw new DesktopHttpError(415, 'This image took too long to convert. Choose a smaller image.')
        throw new DesktopHttpError(415, 'This image is damaged and can’t be attached.')
    } finally { clearTimeout(timer) }
}

function assertConverted(bytes: Uint8Array, width: number, height: number): void {
    if (!bytes.byteLength || bytes.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'This image is too large to attach.')
    const inspected = inspectBytes('png', bytes)
    if (inspected.width !== width || inspected.height !== height) throw new DesktopHttpError(415, 'This image has inconsistent dimensions or format.')
}

/**
 * Validate one picked still image and convert every newly accepted source format to an
 * immutable, model-supported PNG. The raw source bytes never reach a draft, queue, history
 * record, or provider; only the converted bytes and their content hash are stored. The
 * original display filename is returned separately from the canonical visible `.png` name.
 */
export async function inspectComposerImageSource(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<ComposerImageSource> {
    checkOpen(signal)
    const nameProblem = desktopImageNameProblem(name)
    if (nameProblem) throw new DesktopHttpError(415, nameProblem)
    if (bytes.byteLength < 1) throw new DesktopHttpError(415, 'This image is empty and can’t be attached.')
    if (bytes.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
    const kind = desktopImageKindForName(name)!
    if (kind === 'svg') {
        const raster = await rasterizeDesktopSvg(bytes, signal).catch(error => svgFailure(error, signal))
        checkOpen(signal)
        assertConverted(raster.bytes, raster.width, raster.height)
        return { displayName: name, canonicalName: canonicalPngName(name), kind, mediaType: 'image/png', bytes: raster.bytes, width: raster.width, height: raster.height }
    }
    if (kind === 'avif' || kind === 'ico' || kind === 'bmp') {
        const converted = await convertRasterPreviewImage(bytes, kind, signal ?? never).catch(error => rasterFailure(error, signal))
        checkOpen(signal)
        assertConverted(converted.bytes, converted.width, converted.height)
        return { displayName: name, canonicalName: canonicalPngName(name), kind, mediaType: 'image/png', bytes: converted.bytes, width: converted.width, height: converted.height }
    }
    const inspected = await validateStaticRaster(kind, bytes, signal)
    if (kind === 'gif') {
        const png = await encodeGifToPng(bytes, inspected.width, inspected.height, signal)
        checkOpen(signal)
        return { displayName: name, canonicalName: canonicalPngName(name), kind, mediaType: 'image/png', bytes: png, width: inspected.width, height: inspected.height }
    }
    if (desktopImageKindIsConverted(kind)) throw new DesktopHttpError(415, 'This image format can’t be attached.')
    return { displayName: name, canonicalName: name, kind, mediaType: desktopImageMediaType(kind), bytes, width: inspected.width, height: inspected.height }
}

/** Validate the bytes behind a stored snapshot by their canonical media type, never by the
 * original display filename (which may still say `.svg`, `.bmp`, or `.avif`). */
export async function inspectStoredComposerImage(mediaType: DesktopImageMediaType, bytes: Uint8Array): Promise<StoredComposerImage> {
    const kind = mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpeg' : 'webp'
    const inspected = await validateStaticRaster(kind, bytes)
    return { width: inspected.width, height: inspected.height }
}
