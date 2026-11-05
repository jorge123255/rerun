import sharp from 'sharp'
import { expect, test } from 'vitest'
import { desktopRasterKind, inspectDesktopImageBytes } from '../image-bytes'
import { convertRasterPreviewImage, rasterPreviewFailure } from './index'
import { avifContainer, bmp24, ico, iconDib, png1 } from './fixtures'

const signal = () => new AbortController().signal
async function decodedPng(bytes: Uint8Array) {
    return sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}
test('converts real BMP pixels and ICO bitmap/PNG frames to validated browser PNG only', async () => {
    for (const [extension, bytes, width, height] of [
        ['bmp', bmp24(), 2, 2],
        ['ico', ico([{ bytes: iconDib(), width: 1, height: 1 }]), 1, 1],
        ['ico', ico([{ bytes: png1(), width: 1, height: 1 }]), 1, 1],
    ] as const) {
        const display = await convertRasterPreviewImage(bytes, extension, signal())
        expect(display).toMatchObject({ contentType: 'image/png', width, height, frames: 1, animated: false })
        expect(inspectDesktopImageBytes('png', display.bytes)).toMatchObject({ width, height })
        const pixels = await decodedPng(display.bytes)
        expect([...pixels.data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    }
})
test('uses an actual AV1 encoder/decoder for the still AVIF regression, not the synthetic container', async () => {
    const avif = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 2, height: 1, channels: 3 } }).avif({ lossless: true, chromaSubsampling: '4:4:4' }).toBuffer()
    const display = await convertRasterPreviewImage(avif, 'avif', signal())
    expect(display).toMatchObject({ width: 2, height: 1, frames: 1, animated: false, contentType: 'image/png' })
    const pixels = await decodedPng(display.bytes)
    expect(pixels.data[0]).toBeGreaterThan(200)
    expect(pixels.data[2]).toBeLessThan(30)
    expect(pixels.data[5]).toBeGreaterThan(200)
    const alpha = await sharp(Buffer.from([255, 0, 0, 128]), { raw: { width: 1, height: 1, channels: 4 } }).avif({ lossless: true, chromaSubsampling: '4:4:4' }).toBuffer()
    const alphaDisplay = await convertRasterPreviewImage(alpha, 'avif', signal())
    expect((await decodedPng(alphaDisplay.bytes)).data[3]).toBe(128)
    await expect(convertRasterPreviewImage(avifContainer(), 'avif', signal())).rejects.toMatchObject({ reason: 'corrupt' })
})
test('does not expand shared upload/logo/result-card format detection', () => {
    for (const name of ['preview.avif', 'preview.bmp', 'preview.ico']) expect(desktopRasterKind(name)).toBeNull()
    expect(() => inspectDesktopImageBytes('png', bmp24())).toThrow()
})
test('propagates caller abort and returns sanitized, explicit errors', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(convertRasterPreviewImage(bmp24(), 'bmp', controller.signal)).rejects.toMatchObject({ reason: 'aborted' })
    expect(rasterPreviewFailure(new Error('private host path or decoder error'))).toEqual({ status: 415, message: 'This image is damaged or does not match its file extension.' })
})
