/** Preview-only structure checks for coworker Files.
 * Static PNG, JPEG, WebP, and GIF still go through image-bytes.ts.
 * Animated GIF and animated WebP are admitted here, as the original file bytes.
 * Nothing in this module decodes a frame, fetches a URL, or rewrites the file. */

import {
    DESKTOP_IMAGE_MAX_BYTES,
    DESKTOP_IMAGE_MAX_EDGE,
    DESKTOP_IMAGE_MAX_PIXELS,
    DesktopImageBytesError,
    inspectDesktopImageBytes,
    type DesktopImageContentType,
    type DesktopRasterKind,
} from './image-bytes'

export const DESKTOP_PREVIEW_MAX_FRAMES = 256
export const DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS = 48 * 1024 * 1024

export type DesktopPreviewImageReason = 'mismatch' | 'corrupt' | 'dimensions' | 'animation' | 'frames' | 'aggregate'

export class DesktopPreviewImageError extends Error {
    readonly reason: DesktopPreviewImageReason
    constructor(reason: DesktopPreviewImageReason) {
        super(reason)
        this.name = 'DesktopPreviewImageError'
        this.reason = reason
    }
}

export type DesktopPreviewImageInfo = {
    width: number
    height: number
    contentType: DesktopImageContentType
    frames: number
    animated: boolean
    aggregatePixels: number
}

export function inspectDesktopPreviewImageBytes(kind: DesktopRasterKind, bytes: Uint8Array): DesktopPreviewImageInfo {
    if (bytes.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopPreviewImageError('dimensions')
    if (kind === 'gif') return readGif(bytes)
    if (kind === 'webp') return readWebp(bytes)
    try {
        const size = inspectDesktopImageBytes(kind, bytes)
        return { ...size, frames: 1, animated: false, aggregatePixels: size.width * size.height }
    } catch (error) {
        if (error instanceof DesktopImageBytesError) throw new DesktopPreviewImageError(error.reason)
        throw error
    }
}

function assertDimensions(width: number, height: number): void {
    if (width < 1 || height < 1 || width > DESKTOP_IMAGE_MAX_EDGE || height > DESKTOP_IMAGE_MAX_EDGE
        || BigInt(width) * BigInt(height) > BigInt(DESKTOP_IMAGE_MAX_PIXELS)) {
        throw new DesktopPreviewImageError('dimensions')
    }
}

function corrupt(): never {
    throw new DesktopPreviewImageError('corrupt')
}

function mismatch(): never {
    throw new DesktopPreviewImageError('mismatch')
}

function u16le(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u24(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function u32le(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i]!)
    return text
}

function finish(width: number, height: number, frames: number, aggregate: bigint, animated: boolean, contentType: DesktopImageContentType): DesktopPreviewImageInfo {
    if (frames > DESKTOP_PREVIEW_MAX_FRAMES) throw new DesktopPreviewImageError('frames')
    const composited = BigInt(width) * BigInt(height) * BigInt(frames)
    if (aggregate > BigInt(DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS) || composited > BigInt(DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS)) {
        throw new DesktopPreviewImageError('aggregate')
    }
    return { width, height, contentType, frames, animated, aggregatePixels: Number(aggregate) }
}

function readGif(bytes: Uint8Array): DesktopPreviewImageInfo {
    if (bytes.length < 13 || (ascii(bytes, 0, 6) !== 'GIF87a' && ascii(bytes, 0, 6) !== 'GIF89a')) mismatch()
    const width = u16le(bytes, 6)
    const height = u16le(bytes, 8)
    if (width < 1 || height < 1) corrupt()
    assertDimensions(width, height)
    const packed = bytes[10]!
    const table = packed & 0x80 ? 3 * (2 << (packed & 7)) : 0
    let offset = 13 + table
    if (offset > bytes.length) corrupt()
    let frames = 0
    let aggregate = BigInt(0)
    while (offset < bytes.length) {
        const block = bytes[offset++]!
        if (block === 0x3b) {
            if (frames < 1 || offset !== bytes.length) corrupt()
            return finish(width, height, frames, aggregate, frames > 1, 'image/gif')
        }
        // Extension blocks stay inside the file. Their bytes are not URLs and are not fetched.
        if (block === 0x21) {
            if (offset >= bytes.length) corrupt()
            offset = skipGifSubBlocks(bytes, offset + 1)
            continue
        }
        if (block !== 0x2c || offset + 9 > bytes.length) corrupt()
        const left = u16le(bytes, offset)
        const top = u16le(bytes, offset + 2)
        const frameWidth = u16le(bytes, offset + 4)
        const frameHeight = u16le(bytes, offset + 6)
        const framePacked = bytes[offset + 8]!
        if (frameWidth < 1 || frameHeight < 1) corrupt()
        assertDimensions(frameWidth, frameHeight)
        if (frameWidth > width || frameHeight > height || left > width - frameWidth || top > height - frameHeight) corrupt()
        offset += 9
        if (framePacked & 0x80) {
            const local = 3 * (2 << (framePacked & 7))
            if (offset + local > bytes.length) corrupt()
            offset += local
        }
        if (offset >= bytes.length) corrupt()
        const minimum = bytes[offset++]!
        if (minimum < 2 || minimum > 12) corrupt()
        offset = skipGifSubBlocks(bytes, offset)
        frames += 1
        aggregate += BigInt(frameWidth) * BigInt(frameHeight)
        if (frames > DESKTOP_PREVIEW_MAX_FRAMES) throw new DesktopPreviewImageError('frames')
        if (aggregate > BigInt(DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS) || BigInt(width) * BigInt(height) * BigInt(frames) > BigInt(DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS)) {
            throw new DesktopPreviewImageError('aggregate')
        }
    }
    corrupt()
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
    while (offset < bytes.length) {
        const size = bytes[offset++]!
        if (size === 0) return offset
        if (offset + size > bytes.length) corrupt()
        offset += size
    }
    corrupt()
}

function readWebp(bytes: Uint8Array): DesktopPreviewImageInfo {
    if (webpSignalsAnimation(bytes)) return readAnimatedWebp(bytes)
    try {
        const size = inspectDesktopImageBytes('webp', bytes)
        return { ...size, frames: 1, animated: false, aggregatePixels: size.width * size.height }
    } catch (error) {
        if (error instanceof DesktopImageBytesError) throw new DesktopPreviewImageError(error.reason)
        throw error
    }
}

function webpSignalsAnimation(bytes: Uint8Array): boolean {
    if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return false
    let offset = 12
    while (offset + 8 <= bytes.length) {
        const id = ascii(bytes, offset, 4)
        const chunkSize = u32le(bytes, offset + 4)
        if (id === 'ANIM' || id === 'ANMF') return true
        if (id === 'VP8X' && chunkSize >= 1 && offset + 8 < bytes.length && (bytes[offset + 8]! & 0x02) !== 0) return true
        if (chunkSize > bytes.length - (offset + 8)) return false
        const padded = chunkSize + (chunkSize & 1)
        if (offset + 8 + padded > bytes.length) return false
        offset += 8 + padded
    }
    return false
}

function readAnimatedWebp(bytes: Uint8Array): DesktopPreviewImageInfo {
    if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') mismatch()
    if (u32le(bytes, 4) !== bytes.length - 8) corrupt()
    let offset = 12
    let canvas: { width: number; height: number } | null = null
    let sawAnim = false
    let frames = 0
    let aggregate = BigInt(0)
    let first = true
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) corrupt()
        const id = ascii(bytes, offset, 4)
        if (!/^[A-Za-z0-9 ]{4}$/.test(id)) corrupt()
        const chunkSize = u32le(bytes, offset + 4)
        const dataAt = offset + 8
        const padded = chunkSize + (chunkSize & 1)
        if (chunkSize > bytes.length - dataAt || dataAt + padded > bytes.length) corrupt()
        const payload = bytes.subarray(dataAt, dataAt + chunkSize)
        if (first && id !== 'VP8X') corrupt()
        first = false
        if (id === 'VP8X') {
            if (canvas) corrupt()
            canvas = readAnimatedCanvas(payload)
        } else if (!canvas) {
            corrupt()
        } else if (id === 'ICCP' || id === 'EXIF' || id === 'XMP ') {
            // ICC precedes image data; EXIF/XMP may follow the last frame. Metadata is
            // bounded by its chunk and never interpreted as a URL or external resource.
            if ((id === 'ICCP' && frames > 0) || payload.length < 1) corrupt()
        } else if (id === 'ANIM') {
            if (sawAnim || frames > 0 || payload.length !== 6) corrupt()
            sawAnim = true
        } else if (id === 'ANMF') {
            if (!sawAnim) corrupt()
            const area = readAnmf(payload, canvas.width, canvas.height)
            frames += 1
            aggregate += area
            if (frames > DESKTOP_PREVIEW_MAX_FRAMES) throw new DesktopPreviewImageError('frames')
            if (aggregate > BigInt(DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS) || BigInt(canvas.width) * BigInt(canvas.height) * BigInt(frames) > BigInt(DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS)) {
                throw new DesktopPreviewImageError('aggregate')
            }
        } else {
            corrupt()
        }
        offset = dataAt + padded
    }
    if (!canvas || !sawAnim || frames < 1 || offset !== bytes.length) corrupt()
    return finish(canvas.width, canvas.height, frames, aggregate, true, 'image/webp')
}

function readAnimatedCanvas(payload: Uint8Array): { width: number; height: number } {
    if (payload.length !== 10 || payload[1] !== 0 || payload[2] !== 0 || payload[3] !== 0) corrupt()
    // Same reserved bits as static VP8X (0xC1). Animation is required. ICC, alpha, EXIF, and XMP may be set.
    if ((payload[0]! & 0xc1) !== 0 || (payload[0]! & 0x02) === 0) corrupt()
    const width = 1 + (payload[4]! | (payload[5]! << 8) | (payload[6]! << 16))
    const height = 1 + (payload[7]! | (payload[8]! << 8) | (payload[9]! << 16))
    if (width < 1 || height < 1) corrupt()
    assertDimensions(width, height)
    return { width, height }
}

function readAnmf(payload: Uint8Array, canvasWidth: number, canvasHeight: number): bigint {
    if (payload.length < 16) corrupt()
    const x = u24(payload, 0) * 2
    const y = u24(payload, 3) * 2
    const width = u24(payload, 6) + 1
    const height = u24(payload, 9) + 1
    if ((payload[15]! & 0xfc) !== 0) corrupt()
    if (width < 1 || height < 1) corrupt()
    assertDimensions(width, height)
    if (width > canvasWidth || height > canvasHeight || x > canvasWidth - width || y > canvasHeight - height) corrupt()
    let offset = 16
    let image = false
    let alpha = false
    while (offset < payload.length) {
        if (offset + 8 > payload.length) corrupt()
        const id = ascii(payload, offset, 4)
        const size = u32le(payload, offset + 4)
        const dataAt = offset + 8
        const padded = size + (size & 1)
        if (size > payload.length - dataAt || dataAt + padded > payload.length) corrupt()
        const chunk = payload.subarray(dataAt, dataAt + size)
        if (id === 'ALPH') {
            if (alpha || image || chunk.length < 1) corrupt()
            alpha = true
        } else if (id === 'VP8 ' || id === 'VP8L') {
            if (image) corrupt()
            const frame = id === 'VP8 ' ? readVp8(chunk) : readVp8l(chunk)
            if (frame.width !== width || frame.height !== height) corrupt()
            image = true
        } else {
            corrupt()
        }
        offset = dataAt + padded
    }
    if (!image || offset !== payload.length) corrupt()
    return BigInt(width) * BigInt(height)
}

function readVp8(payload: Uint8Array): { width: number; height: number } {
    if (payload.length < 10 || (payload[0]! & 1) !== 0) corrupt()
    if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) corrupt()
    const width = (payload[6]! | (payload[7]! << 8)) & 0x3fff
    const height = (payload[8]! | (payload[9]! << 8)) & 0x3fff
    if (width < 1 || height < 1) corrupt()
    assertDimensions(width, height)
    return { width, height }
}

function readVp8l(payload: Uint8Array): { width: number; height: number } {
    if (payload.length < 5 || payload[0] !== 0x2f) corrupt()
    const bits = (payload[1]! | (payload[2]! << 8) | (payload[3]! << 16) | (payload[4]! << 24)) >>> 0
    if ((bits >>> 29) !== 0) corrupt()
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    assertDimensions(width, height)
    return { width, height }
}
