/** Safety budgets and error type for the bounded SVG preview adapter.
 * The shared raster ceilings (8 MiB input, 8192 edge, 16,777,216 pixels) stay the
 * absolute limits; the SVG-specific structure budgets below are stricter. */
import { DESKTOP_IMAGE_MAX_BYTES, DESKTOP_IMAGE_MAX_EDGE, DESKTOP_IMAGE_MAX_PIXELS } from '../image-bytes'

export const DESKTOP_SVG_MAX_BYTES = DESKTOP_IMAGE_MAX_BYTES
export const DESKTOP_SVG_MAX_CHARS = DESKTOP_IMAGE_MAX_BYTES
export const DESKTOP_SVG_MAX_EDGE = DESKTOP_IMAGE_MAX_EDGE
export const DESKTOP_SVG_MAX_PIXELS = DESKTOP_IMAGE_MAX_PIXELS
export const DESKTOP_SVG_MAX_ELEMENTS = 4096
export const DESKTOP_SVG_MAX_DEPTH = 128
export const DESKTOP_SVG_MAX_ATTRIBUTES = 64
export const DESKTOP_SVG_MAX_TOTAL_ATTRIBUTES = 16_384
export const DESKTOP_SVG_MAX_ATTRIBUTE_VALUE_CHARS = 65_536
export const DESKTOP_SVG_MAX_TEXT_CHARS = 2 * 1024 * 1024
/** The rasterized PNG must fit the shared byte ceiling or it is downscaled and retried. */
export const DESKTOP_SVG_MAX_PNG_BYTES = DESKTOP_IMAGE_MAX_BYTES

export type DesktopSvgReason =
    | 'mismatch' // Not an XML SVG document at all.
    | 'corrupt' // Malformed XML or UTF-8, or a rasterizer failure on the canonical document.
    | 'unsupported' // Well-formed, but a feature outside the previewed subset (script, entities, style, unknown elements/attributes…).
    | 'external' // A resource reference outside the document (http/file/data URL, non-fragment href, non-local url()).
    | 'dimensions' // Geometry or rendered output cannot be bounded.
    | 'complex' // A structure budget (elements, depth, attributes, text, value length) was exceeded.

export class DesktopSvgError extends Error {
    readonly reason: DesktopSvgReason
    readonly detail?: string
    constructor(reason: DesktopSvgReason, detail?: string) {
        super(detail === undefined ? reason : `${reason}: ${detail}`)
        this.name = 'DesktopSvgError'
        this.reason = reason
        this.detail = detail
    }
}
