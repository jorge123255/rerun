import { expect, test } from 'vitest'
import { DESKTOP_IMAGE_MAX_BYTES } from '../image-bytes'
import { inspectRasterPreviewImage, RasterPreviewError } from './index'
import { inspectBitmap, decodeBitmap } from './bitmap'
import { avifContainer, bmp24, bmpBitfields, bmpIndexed, box, ico, iconDib, png1, pngChunk } from './fixtures'

const signal = () => new AbortController().signal
const rejects = (bytes: Uint8Array, extension: string, reason: string) => {
    try { inspectRasterPreviewImage(bytes, extension, signal()); throw new Error('Expected inspection refusal') }
    catch (error) { expect(error).toBeInstanceOf(RasterPreviewError); expect((error as RasterPreviewError).reason).toBe(reason) }
}
test('inspects a static AVIF container without claiming its synthetic AV1 payload decodes', () => {
    expect(inspectRasterPreviewImage(avifContainer(), 'avif', signal())).toMatchObject({ width: 1, height: 1, sourceFrames: 1, frames: 1, animated: false })
    rejects(avifContainer({ width: 8193 }), 'avif', 'dimensions')
    rejects(avifContainer({ width: 8192, height: 8192 }), 'avif', 'dimensions')
    rejects(avifContainer({ codedWidth: 2 }), 'avif', 'corrupt')
    rejects(avifContainer({ codedWidth: 8192, codedHeight: 8192 }), 'avif', 'dimensions')
    rejects(avifContainer({ extraFrame: true }), 'avif', 'animation')
    rejects(avifContainer({ brand: 'avis' }), 'avif', 'animation')
    rejects(Buffer.concat([avifContainer(), box('moov')]), 'avif', 'animation')
    rejects(avifContainer({ dataReference: 1 }), 'avif', 'unsupported')
    rejects(avifContainer({ itemType: 'grid' }), 'avif', 'unsupported')
    const truncated = avifContainer().subarray(0, -1)
    rejects(truncated, 'avif', 'corrupt')
})
test('validates all ICO entries and chooses area, bit depth, then directory order deterministically', () => {
    const data = ico([{ bytes: iconDib(), width: 1, height: 1 }, { bytes: iconDib(2, 2), width: 2, height: 2 }, { bytes: iconDib(2, 2), width: 2, height: 2 }])
    expect(inspectRasterPreviewImage(data, 'ico', signal())).toMatchObject({ width: 2, height: 2, selectedFrame: 1, sourceFrames: 3, frames: 1, animated: false, aggregatePixels: 9 })
    const overlap = Buffer.from(data); overlap.writeUInt32LE(overlap.readUInt32LE(18), 34)
    rejects(overlap, 'ico', 'corrupt')
    const mismatch = ico([{ bytes: iconDib(), width: 2, height: 1 }])
    rejects(mismatch, 'ico', 'corrupt')
    const tooMany = Buffer.alloc(6); tooMany.writeUInt16LE(1, 2); tooMany.writeUInt16LE(65, 4)
    rejects(tooMany, 'ico', 'frames')
    const png = ico([{ bytes: png1(), width: 1, height: 1 }])
    expect(inspectRasterPreviewImage(png, 'ico', signal()).selectedFrame).toBe(0)
    const animated = Buffer.concat([png1().subarray(0, 33), pngChunk('acTL', Buffer.alloc(8)), png1().subarray(33)])
    rejects(ico([{ bytes: animated, width: 1, height: 1 }]), 'ico', 'animation')
})
test('decodes BMP row padding, both orientations and indexed palettes without native BMP support', async () => {
    for (const topDown of [false, true]) {
        const bytes = bmp24(2, 2, topDown), plan = inspectBitmap(bytes)
        const rgba = await decodeBitmap(bytes, plan, signal())
        expect([...rgba]).toEqual([255, 0, 0, 255, 255, 255, 0, 255, 0, 0, 255, 255, 0, 255, 255, 255])
    }
    const indexed = bmpIndexed()
    expect([...await decodeBitmap(indexed, inspectBitmap(indexed), signal())]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
    for (const alpha of [false, true]) {
        const fields = bmpBitfields(alpha)
        expect([...await decodeBitmap(fields, inspectBitmap(fields), signal())]).toEqual([255, 0, 0, alpha ? 128 : 255])
    }
    const overlap = bmpBitfields(); overlap.writeUInt32LE(0xf800, 58)
    rejects(overlap, 'bmp', 'corrupt')
    const profile = Buffer.alloc(142); bmp24(1, 1).copy(profile, 0, 0, 54)
    profile.writeUInt32LE(profile.length, 2); profile.writeUInt32LE(138, 10); profile.writeUInt32LE(124, 14); profile.writeUInt32LE(1, 126)
    rejects(profile, 'bmp', 'unsupported')
    const corrupt = bmp24(); corrupt.writeUInt32LE(1, 30)
    rejects(corrupt, 'bmp', 'unsupported')
    const dimensions = bmp24(); dimensions.writeInt32LE(8193, 18)
    rejects(dimensions, 'bmp', 'dimensions')
    const offset = bmp24(); offset.writeUInt32LE(0xfffffff0, 10)
    rejects(offset, 'bmp', 'corrupt')
    const size = bmp24(); size.writeUInt32LE(size.length - 1, 2)
    rejects(size, 'bmp', 'corrupt')
})
test('preserves ICO alpha and applies the legacy AND mask when all alpha bytes are zero', async () => {
    const normal = iconDib(1, 1, 128, true)
    expect((await decodeBitmap(normal, inspectBitmap(normal, { width: 1, height: 1 }), signal()))[3]).toBe(128)
    const opaque = iconDib(1, 1, 0)
    expect((await decodeBitmap(opaque, inspectBitmap(opaque, { width: 1, height: 1 }), signal()))[3]).toBe(255)
    const transparent = iconDib(1, 1, 0, true)
    expect((await decodeBitmap(transparent, inspectBitmap(transparent, { width: 1, height: 1 }), signal()))[3]).toBe(0)
})
test('keeps input/format/abort ceilings and allows cancellation during bitmap rows', async () => {
    rejects(new Uint8Array(DESKTOP_IMAGE_MAX_BYTES + 1), 'bmp', 'dimensions')
    rejects(png1(), 'bmp', 'mismatch')
    const closed = new AbortController(); closed.abort()
    expect(() => inspectRasterPreviewImage(bmp24(), 'bmp', closed.signal)).toThrow(RasterPreviewError)
    const controller = new AbortController(), bytes = bmp24(32, 32)
    const decoding = decodeBitmap(bytes, inspectBitmap(bytes), controller.signal)
    controller.abort()
    await expect(decoding).rejects.toMatchObject({ reason: 'aborted' })
})
