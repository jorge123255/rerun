/** Structural checks for a desktop Files image. Static PNG, JPEG, WebP, and GIF only.
 * The bytes are not a hosted URL, an SVG, or HTML. Pixel decode stays in the browser. */

export const DESKTOP_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const DESKTOP_IMAGE_MAX_EDGE = 8192
export const DESKTOP_IMAGE_MAX_PIXELS = 16_777_216

export type DesktopRasterKind = 'png' | 'jpeg' | 'gif' | 'webp'
export type DesktopImageContentType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const CONTENT_TYPE: Record<DesktopRasterKind, DesktopImageContentType> = {
    png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}

export class DesktopImageBytesError extends Error {
    readonly reason: 'mismatch' | 'corrupt' | 'dimensions' | 'animation'
    constructor(reason: 'mismatch' | 'corrupt' | 'dimensions' | 'animation') {
        super(reason)
        this.name = 'DesktopImageBytesError'
        this.reason = reason
    }
}

export function desktopRasterKind(name: string): DesktopRasterKind | null {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    if (ext === 'png') return 'png'
    if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
    if (ext === 'gif') return 'gif'
    if (ext === 'webp') return 'webp'
    return null
}

export function inspectDesktopImageBytes(kind: DesktopRasterKind, bytes: Uint8Array): { width: number; height: number; contentType: DesktopImageContentType } {
    if (bytes.byteLength > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopImageBytesError('dimensions')
    const size = kind === 'png' ? readPng(bytes) : kind === 'jpeg' ? readJpeg(bytes) : kind === 'gif' ? readGif(bytes) : readWebp(bytes)
    assertDimensions(size.width, size.height)
    return { ...size, contentType: CONTENT_TYPE[kind] }
}

function assertDimensions(width: number, height: number): void {
    if (width < 1 || height < 1 || width > DESKTOP_IMAGE_MAX_EDGE || height > DESKTOP_IMAGE_MAX_EDGE
        || BigInt(width) * BigInt(height) > BigInt(DESKTOP_IMAGE_MAX_PIXELS)) {
        throw new DesktopImageBytesError('dimensions')
    }
}

function animated(): never {
    throw new DesktopImageBytesError('animation')
}

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[n] = c >>> 0
}

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function u32be(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function u16le(bytes: Uint8Array, offset: number): number {
    return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u32le(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    let text = ''
    for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i]!)
    return text
}

function corrupt(): never {
    throw new DesktopImageBytesError('corrupt')
}

function mismatch(): never {
    throw new DesktopImageBytesError('mismatch')
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readPng(bytes: Uint8Array): { width: number; height: number } {
    if (bytes.length < 8 || PNG_SIG.some((byte, index) => bytes[index] !== byte)) mismatch()
    let offset = 8
    let width = 0
    let height = 0
    let sawHeader = false
    let sawData = false
    let sawEnd = false
    let colorType = -1
    let sawPalette = false
    while (offset + 12 <= bytes.length) {
        const length = u32be(bytes, offset)
        if (length > bytes.length - offset - 12) corrupt()
        const typeStart = offset + 4
        const type = ascii(bytes, typeStart, 4)
        if (!/^[A-Za-z]{4}$/.test(type)) corrupt()
        const dataStart = offset + 8
        const crcAt = dataStart + length
        if (crc32(bytes.subarray(typeStart, crcAt)) !== u32be(bytes, crcAt)) corrupt()
        // APNG's additional images must not bypass the single-frame decoded-pixel budget.
        if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') animated()
        const critical = type[0]! >= 'A' && type[0]! <= 'Z'
        if (critical && type !== 'IHDR' && type !== 'PLTE' && type !== 'IDAT' && type !== 'IEND') corrupt()
        if (!sawHeader && type !== 'IHDR') corrupt()
        if (sawEnd) corrupt()
        if (type === 'IHDR') {
            if (sawHeader || length !== 13) corrupt()
            width = u32be(bytes, dataStart)
            height = u32be(bytes, dataStart + 4)
            if (!validPngHeader(bytes[dataStart + 8]!, bytes[dataStart + 9]!, bytes[dataStart + 10]!, bytes[dataStart + 11]!, bytes[dataStart + 12]!)) corrupt()
            colorType = bytes[dataStart + 9]!
            sawHeader = true
            assertDimensions(width, height)
        } else if (type === 'PLTE') {
            if (sawData || length % 3 !== 0 || length < 3 || length > 256 * 3) corrupt()
            sawPalette = true
        } else if (type === 'IDAT') {
            if (colorType === 3 && !sawPalette) corrupt()
            sawData = true
        } else if (type === 'IEND') {
            if (length !== 0 || !sawData) corrupt()
            sawEnd = true
        }
        offset = crcAt + 4
        if (sawEnd) break
    }
    if (!sawHeader || !sawEnd || offset !== bytes.length) corrupt()
    return { width, height }
}

function validPngHeader(bit: number, color: number, compression: number, filter: number, interlace: number): boolean {
    if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return false
    const allowed: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
    return (allowed[color] ?? []).includes(bit)
}

function readJpeg(bytes: Uint8Array): { width: number; height: number } {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) mismatch()
    let offset = 2
    let size: { width: number; height: number } | null = null
    while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) corrupt()
        let markerAt = offset + 1
        while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt++
        if (markerAt >= bytes.length) corrupt()
        const marker = bytes[markerAt]!
        if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) corrupt()
        if (marker === 0xd9) {
            if (!size || markerAt + 1 !== bytes.length) corrupt()
            return size
        }
        const lengthAt = markerAt + 1
        if (lengthAt + 2 > bytes.length) corrupt()
        const segmentLength = (bytes[lengthAt]! << 8) | bytes[lengthAt + 1]!
        if (segmentLength < 2 || lengthAt + segmentLength > bytes.length) corrupt()
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
            if (size || segmentLength < 8) corrupt()
            const precision = bytes[lengthAt + 2]!
            const height = (bytes[lengthAt + 3]! << 8) | bytes[lengthAt + 4]!
            const width = (bytes[lengthAt + 5]! << 8) | bytes[lengthAt + 6]!
            const components = bytes[lengthAt + 7]!
            if (precision !== 8 || (components !== 1 && components !== 3) || segmentLength !== 8 + components * 3) corrupt()
            if (width < 1 || height < 1) corrupt()
            size = { width, height }
        } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
            corrupt()
        }
        if (marker === 0xda) {
            if (!size) corrupt()
            offset = skipJpegScan(bytes, lengthAt + segmentLength)
            continue
        }
        offset = lengthAt + segmentLength
    }
    corrupt()
}

function skipJpegScan(bytes: Uint8Array, offset: number): number {
    while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue }
        let next = offset + 1
        while (next < bytes.length && bytes[next] === 0xff) next++
        if (next >= bytes.length) corrupt()
        const marker = bytes[next]!
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) { offset = next + 1; continue }
        return offset
    }
    corrupt()
}

function readGif(bytes: Uint8Array): { width: number; height: number } {
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
    while (offset < bytes.length) {
        const block = bytes[offset++]!
        if (block === 0x3b) {
            if (frames < 1 || offset !== bytes.length) corrupt()
            return { width, height }
        }
        if (block === 0x21) {
            if (offset >= bytes.length) corrupt()
            offset = skipGifSubBlocks(bytes, offset + 1)
            continue
        }
        if (block !== 0x2c || offset + 9 > bytes.length) corrupt()
        if (frames !== 0) animated()
        const left = u16le(bytes, offset)
        const top = u16le(bytes, offset + 2)
        const frameWidth = u16le(bytes, offset + 4)
        const frameHeight = u16le(bytes, offset + 6)
        const framePacked = bytes[offset + 8]!
        if (frameWidth < 1 || frameHeight < 1) corrupt()
        assertDimensions(frameWidth, frameHeight)
        if (left + frameWidth > width || top + frameHeight > height) corrupt()
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
        frames++
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

function readWebp(bytes: Uint8Array): { width: number; height: number } {
    if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') mismatch()
    if (u32le(bytes, 4) !== bytes.length - 8) corrupt()
    let offset = 12
    let size: { width: number; height: number } | null = null
    let image = false
    while (offset < bytes.length) {
        if (offset + 8 > bytes.length) corrupt()
        const id = ascii(bytes, offset, 4)
        if (!/^[A-Za-z0-9 ]{4}$/.test(id)) corrupt()
        const chunkSize = u32le(bytes, offset + 4)
        const dataAt = offset + 8
        const padded = chunkSize + (chunkSize & 1)
        if (chunkSize > bytes.length - dataAt || dataAt + padded > bytes.length) corrupt()
        const payload = bytes.subarray(dataAt, dataAt + chunkSize)
        // Animated containers and nested frame payloads are outside this static preview slice.
        // Reject even malformed/empty animation chunks rather than treating them as image data.
        if (id === 'ANIM' || id === 'ANMF') animated()
        if (!size && id !== 'VP8 ' && id !== 'VP8L' && id !== 'VP8X') corrupt()
        if (id === 'VP8X') {
            if (size) corrupt()
            size = readVp8x(payload)
        } else if (id === 'VP8 ') {
            const frame = readVp8(payload)
            if (image || (size && (size.width !== frame.width || size.height !== frame.height))) corrupt()
            if (!size) size = frame
            image = true
        } else if (id === 'VP8L') {
            const frame = readVp8l(payload)
            if (image || (size && (size.width !== frame.width || size.height !== frame.height))) corrupt()
            if (!size) size = frame
            image = true
        }
        offset = dataAt + padded
    }
    if (!size || !image || offset !== bytes.length) corrupt()
    return size
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

function readVp8x(payload: Uint8Array): { width: number; height: number } {
    if (payload.length !== 10 || payload[1] !== 0 || payload[2] !== 0 || payload[3] !== 0 || (payload[0]! & 0xc1) !== 0) corrupt()
    if ((payload[0]! & 0x02) !== 0) animated()
    const width = 1 + (payload[4]! | (payload[5]! << 8) | (payload[6]! << 16))
    const height = 1 + (payload[7]! | (payload[8]! << 8) | (payload[9]! << 16))
    if (width < 1 || height < 1) corrupt()
    assertDimensions(width, height)
    return { width, height }
}
