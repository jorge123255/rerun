import { DESKTOP_IMAGE_MAX_BYTES, DESKTOP_IMAGE_MAX_EDGE, DESKTOP_IMAGE_MAX_PIXELS } from '../image-bytes'

export type RasterPreviewFormat = 'avif' | 'ico' | 'bmp'
export type RasterPreviewReason = 'mismatch' | 'corrupt' | 'dimensions' | 'animation' | 'unsupported' | 'frames' | 'output' | 'aborted' | 'dependency'
export class RasterPreviewError extends Error {
    constructor(readonly reason: RasterPreviewReason) { super(`Raster preview: ${reason}`); this.name = 'RasterPreviewError' }
}
export type RasterPreviewInspection = {
    format: RasterPreviewFormat
    width: number
    height: number
    frames: 1
    animated: false
    sourceFrames: number
    aggregatePixels: number
    selectedFrame?: number
}
export type RasterPreviewDisplay = RasterPreviewInspection & { bytes: Uint8Array; contentType: 'image/png' }
export function fail(reason: RasterPreviewReason): never { throw new RasterPreviewError(reason) }
export function checkOpen(signal: AbortSignal): void { if (signal.aborted) fail('aborted') }
export function checkInput(bytes: Uint8Array, signal: AbortSignal): void {
    checkOpen(signal)
    if (!bytes.length) fail('corrupt')
    if (bytes.length > DESKTOP_IMAGE_MAX_BYTES) fail('dimensions')
}
export function dimensions(width: number, height: number): void {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > DESKTOP_IMAGE_MAX_EDGE || height > DESKTOP_IMAGE_MAX_EDGE || width * height > DESKTOP_IMAGE_MAX_PIXELS) fail('dimensions')
}
export function aggregate(pixels: number): void { if (pixels > DESKTOP_IMAGE_MAX_PIXELS) fail('dimensions') }
export function formatOf(extension: string): RasterPreviewFormat {
    const value = extension.toLowerCase().replace(/^\./, '')
    if (value !== 'avif' && value !== 'ico' && value !== 'bmp') fail('unsupported')
    return value
}
export class Bytes {
    readonly view: DataView
    constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
    range(at: number, length: number): void { if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at > this.bytes.length - length) fail('corrupt') }
    u8(at: number): number { this.range(at, 1); return this.view.getUint8(at) }
    u16(at: number, little = false): number { this.range(at, 2); return this.view.getUint16(at, little) }
    u32(at: number, little = false): number { this.range(at, 4); return this.view.getUint32(at, little) }
    i32(at: number): number { this.range(at, 4); return this.view.getInt32(at, true) }
    uint(at: number, size: number): number {
        this.range(at, size)
        if (size === 0) return 0
        if (size === 4) return this.u32(at)
        if (size === 8) { const value = this.u32(at) * 0x1_0000_0000 + this.u32(at + 4); if (!Number.isSafeInteger(value)) fail('corrupt'); return value }
        fail('unsupported')
    }
    ascii(at: number, length: number): string { this.range(at, length); return String.fromCharCode(...this.bytes.subarray(at, at + length)) }
}
