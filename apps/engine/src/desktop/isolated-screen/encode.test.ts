import { describe, expect, it } from 'vitest'
import { encodeScreenJpeg } from './encode.js'

describe('encodeScreenJpeg', () => {
    it('returns jpeg bytes of the view size', async () => {
        const { default: sharp } = await import('sharp')
        const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#123456' } }).png().toBuffer()
        const jpeg = await encodeScreenJpeg(png, 2, 1)
        expect(jpeg[0]).toBe(0xff)
        expect(jpeg[1]).toBe(0xd8)
        expect(jpeg.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true)
        const decoded = sharp(jpeg)
        expect(await decoded.metadata()).toMatchObject({ format: 'jpeg', width: 2, height: 1 })
    })
})
