import { expect, test, vi } from 'vitest'
import { inspectDesktopImageBytes } from './image-bytes'
import {
    DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS,
    DESKTOP_PREVIEW_MAX_FRAMES,
    DesktopPreviewImageError,
    inspectDesktopPreviewImageBytes,
} from './animated-image'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Af//Z', 'base64')
const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64')

function pngChunk(type: string, payload: Buffer) {
    const content = Buffer.concat([Buffer.from(type, 'ascii'), payload])
    let crc = 0xffffffff
    for (const byte of content) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, content, tail])
}

function webpChunk(type: string, payload: Buffer) {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32LE(payload.length, 4)
    return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function webpFile(...chunks: Buffer[]) {
    const content = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks])
    const header = Buffer.alloc(8)
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(content.length, 4)
    return Buffer.concat([header, content])
}

function vp8x(width = 1, height = 1, flags = 0) {
    const header = Buffer.alloc(10)
    header[0] = flags
    header.writeUIntLE(width - 1, 4, 3)
    header.writeUIntLE(height - 1, 7, 3)
    return webpChunk('VP8X', header)
}

function vp8Frame(width: number, height: number) {
    const header = Buffer.alloc(10)
    header.set([0x9d, 0x01, 0x2a], 3)
    header.writeUInt16LE(width, 6)
    header.writeUInt16LE(height, 8)
    return webpChunk('VP8 ', header)
}

function anmf(imageChunk: Buffer, width: number, height: number) {
    const header = Buffer.alloc(16)
    header.writeUIntLE(width - 1, 6, 3)
    header.writeUIntLE(height - 1, 9, 3)
    return webpChunk('ANMF', Buffer.concat([header, imageChunk]))
}

function gifFrames(count: number, width = 1, height = 1) {
    const header = Buffer.alloc(13)
    header.write('GIF89a', 0, 'ascii')
    header.writeUInt16LE(width, 6)
    header.writeUInt16LE(height, 8)
    const frame = Buffer.alloc(12)
    frame[0] = 0x2c
    frame.writeUInt16LE(width, 5)
    frame.writeUInt16LE(height, 7)
    frame[10] = 2
    return Buffer.concat([header, ...Array.from({ length: count }, () => frame), Buffer.from([0x3b])])
}

function reason(kind: 'png' | 'jpeg' | 'gif' | 'webp', bytes: Buffer): string {
    try {
        inspectDesktopPreviewImageBytes(kind, bytes)
        return ''
    } catch (error) {
        return error instanceof DesktopPreviewImageError ? error.reason : 'other'
    }
}

test('still images stay one frame and animated GIF and WebP keep every frame', () => {
    expect(inspectDesktopPreviewImageBytes('png', png)).toMatchObject({ width: 1, height: 1, frames: 1, animated: false, contentType: 'image/png' })
    expect(inspectDesktopPreviewImageBytes('jpeg', jpeg)).toMatchObject({ frames: 1, animated: false, contentType: 'image/jpeg' })
    expect(inspectDesktopPreviewImageBytes('gif', gif)).toMatchObject({ width: 1, height: 1, frames: 1, animated: false, contentType: 'image/gif' })
    expect(inspectDesktopPreviewImageBytes('webp', webp)).toMatchObject({ frames: 1, animated: false, contentType: 'image/webp' })

    const descriptor = gif.indexOf(0x2c)
    const two = Buffer.concat([gif.subarray(0, gif.length - 1), gif.subarray(descriptor)])
    expect(inspectDesktopPreviewImageBytes('gif', two)).toMatchObject({ frames: 2, animated: true, aggregatePixels: 2 })

    const frame = vp8Frame(1, 1)
    const animated = webpFile(vp8x(1, 1, 0x02), webpChunk('ANIM', Buffer.alloc(6)), anmf(frame, 1, 1), anmf(frame, 1, 1))
    expect(inspectDesktopPreviewImageBytes('webp', animated)).toMatchObject({ width: 1, height: 1, frames: 2, animated: true, aggregatePixels: 2, contentType: 'image/webp' })
    const single = webpFile(vp8x(1, 1, 0x02), webpChunk('ANIM', Buffer.alloc(6)), anmf(frame, 1, 1))
    expect(inspectDesktopPreviewImageBytes('webp', single)).toMatchObject({ frames: 1, animated: true, aggregatePixels: 1 })
})

test('a comment that looks like a URL stays in the GIF and is not fetched', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const url = Buffer.from('http://example.test/frame.png')
    const block = Buffer.concat([Buffer.from([0x21, 0xfe, url.length]), url, Buffer.from([0])])
    const commented = Buffer.concat([gif.subarray(0, gif.length - 1), block, Buffer.from([0x3b])])
    expect(inspectDesktopPreviewImageBytes('gif', commented)).toMatchObject({ frames: 1, animated: false })
    const frame = vp8Frame(1, 1)
    const described = webpFile(
        vp8x(1, 1, 0x26),
        webpChunk('ICCP', Buffer.from([1])),
        webpChunk('XMP ', Buffer.from('http://example.test/frame.png')),
        webpChunk('ANIM', Buffer.alloc(6)),
        anmf(frame, 1, 1),
    )
    expect(inspectDesktopPreviewImageBytes('webp', described)).toMatchObject({ frames: 1, animated: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
})

test('frame count, aggregate pixels, canvas fit, and APNG stay bounded', () => {
    expect(reason('gif', gifFrames(DESKTOP_PREVIEW_MAX_FRAMES + 1))).toBe('frames')
    expect(reason('gif', gifFrames(4, 4000, 4000))).toBe('aggregate')
    expect(DESKTOP_PREVIEW_MAX_AGGREGATE_PIXELS).toBe(48 * 1024 * 1024)
    expect(inspectDesktopPreviewImageBytes('gif', gifFrames(2))).toMatchObject({ frames: 2, animated: true })

    const outside = Buffer.from(gif)
    outside.writeUInt16LE(1, gif.indexOf(0x2c) + 1)
    expect(reason('gif', outside)).toBe('corrupt')
    const oversized = Buffer.from(gif)
    oversized.writeUInt16LE(8193, gif.indexOf(0x2c) + 5)
    expect(reason('gif', oversized)).toBe('dimensions')

    const apng = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', Buffer.alloc(8)), png.subarray(33)])
    expect(reason('png', apng)).toBe('animation')
    expect(() => inspectDesktopImageBytes('png', apng)).toThrowError(expect.objectContaining({ reason: 'animation' }))

    expect(reason('webp', webpFile(vp8x(1, 1, 0x02), webp.subarray(12)))).toBe('corrupt')
    expect(reason('webp', webpFile(vp8x(), webpChunk('ANMF', Buffer.alloc(0))))).toBe('corrupt')
    expect(reason('webp', webpFile(vp8x(), webpChunk('ANIM', Buffer.alloc(6)), webp.subarray(12)))).toBe('corrupt')
    const frame = vp8Frame(1, 1)
    expect(reason('webp', webpFile(vp8x(1, 1, 0x03), webpChunk('ANIM', Buffer.alloc(6)), anmf(frame, 1, 1)))).toBe('corrupt')
})

test('animated WebP permits EXIF and XMP metadata after the final frame', () => {
    const bytes = webpFile(vp8x(1, 1, 0x0e), webpChunk('ANIM', Buffer.alloc(6)),
        anmf(vp8Frame(1, 1), 1, 1), webpChunk('EXIF', Buffer.from('metadata')),
        webpChunk('XMP ', Buffer.from('http://example.test/not-fetched')))
    expect(inspectDesktopPreviewImageBytes('webp', bytes)).toMatchObject({ animated: true, frames: 1 })
    expect(() => inspectDesktopImageBytes('webp', bytes)).toThrowError(expect.objectContaining({ reason: 'animation' }))
})
