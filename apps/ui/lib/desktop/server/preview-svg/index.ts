import 'server-only'
import sharp from 'sharp'
import { DesktopHttpError } from '../auth'
import { DesktopImageBytesError, inspectDesktopImageBytes } from '../image-bytes'
import { DesktopSvgError } from './budgets'
import { xmlTokens } from './xml-tokens'
import { validateSvg, type ValidatedSvg } from './svg-subset'

export {
    DESKTOP_SVG_MAX_ATTRIBUTES,
    DESKTOP_SVG_MAX_ATTRIBUTE_VALUE_CHARS,
    DESKTOP_SVG_MAX_BYTES,
    DESKTOP_SVG_MAX_CHARS,
    DESKTOP_SVG_MAX_DEPTH,
    DESKTOP_SVG_MAX_EDGE,
    DESKTOP_SVG_MAX_ELEMENTS,
    DESKTOP_SVG_MAX_PIXELS,
    DESKTOP_SVG_MAX_PNG_BYTES,
    DESKTOP_SVG_MAX_TEXT_CHARS,
    DESKTOP_SVG_MAX_TOTAL_ATTRIBUTES,
    DesktopSvgError,
    type DesktopSvgReason,
} from './budgets'
export { inspectDesktopImageBytes } from '../image-bytes'

export type DesktopSvgInspection = { width: number; height: number; contentType: 'image/png' }
export type DesktopSvgRaster = {
    bytes: Uint8Array
    contentType: 'image/png'
    width: number
    height: number
    frames: 1
    animated: false
}

export const DESKTOP_SVG_RASTERIZE_ATTEMPTS = 4

const SVG_NAME = /\.svg$/i

/** Name gate mirroring the raster preview's `isDesktopRasterName`: a plain, workspace-relative
 * .svg name (never a path or a hostname) that root's dispatcher should route to this adapter. */
export function isDesktopSvgName(name: string): boolean {
    return !name.includes('/') && !name.includes('\\') && !name.includes('\0') && SVG_NAME.test(name)
}

function parseDesktopSvg(bytes: Uint8Array): ValidatedSvg {
    return validateSvg(xmlTokens(bytes))
}

/** Pure structural inspection: parses, validates the strict subset, and resolves the
 * bounded output size. No rasterization and no filesystem access, so regressions can
 * assert the whole rejection table without sharp. */
export function inspectDesktopSvg(bytes: Uint8Array): DesktopSvgInspection {
    const { width, height } = parseDesktopSvg(bytes)
    return { width, height, contentType: 'image/png' }
}

/** Abort between every bounded stage of the preview, mirroring the raster preview's 499. */
export function assertSvgPreviewOpen(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DesktopHttpError(499, 'SVG preview was closed.')
}

/** Rasterize one confined SVG file to a bounded, inert PNG.
 * The file's own bytes are only ever fed to the bounded tokenizer; the rasterizer receives
 * the canonical XML re-serialized from the validated subset, so scripts, DTDs, entities,
 * event handlers, external styles/fonts/images, and resource URLs cannot reach it.
 * A rendered PNG that exceeds the 8 MB response ceiling is downscaled and retried. */
export async function rasterizeDesktopSvg(bytes: Uint8Array, signal?: AbortSignal): Promise<DesktopSvgRaster> {
    assertSvgPreviewOpen(signal)
    const parsed = parseDesktopSvg(bytes)
    assertSvgPreviewOpen(signal)
    let width = parsed.width
    let height = parsed.height
    for (let attempt = 0; attempt < DESKTOP_SVG_RASTERIZE_ATTEMPTS; attempt++) {
        assertSvgPreviewOpen(signal)
        let png: Buffer
        try {
            png = await sharp(Buffer.from(parsed.render(width, height), 'utf8'), { failOn: 'warning' })
                .png()
                .timeout({ seconds: 10 })
                .toBuffer()
        } catch {
            // The input here is our own canonical XML; a renderer failure means it could
            // not rasterize the validated document, which is a damaged-preview condition.
            throw new DesktopSvgError('corrupt', 'SVG rasterization failed')
        }
        assertSvgPreviewOpen(signal)
        if (png.byteLength > DESKTOP_SVG_MAX_PNG_BYTES) {
            width = Math.max(1, Math.floor(width / 2))
            height = Math.max(1, Math.floor(height / 2))
            continue
        }
        let inspected: ReturnType<typeof inspectDesktopImageBytes>
        try {
            inspected = inspectDesktopImageBytes('png', new Uint8Array(png))
        } catch (error) {
            if (error instanceof DesktopImageBytesError && error.reason === 'dimensions') {
                throw new DesktopSvgError('dimensions')
            }
            throw new DesktopSvgError('corrupt', 'SVG rasterization failed')
        }
        assertSvgPreviewOpen(signal)
        return {
            bytes: new Uint8Array(png),
            contentType: 'image/png',
            width: inspected.width,
            height: inspected.height,
            frames: 1,
            animated: false,
        }
    }
    throw new DesktopSvgError('dimensions', 'SVG preview is still too large after downscaling')
}
