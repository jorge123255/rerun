import { expect, test } from 'vitest'
import sharp from 'sharp'
import { DesktopSvgError, rasterizeDesktopSvg } from './index'
import {
    HOSTILE_SCRIPT,
    SAFE_BIG,
    SAFE_NOISE,
    SAFE_RED_CIRCLE,
    SAFE_TRANSPARENT,
} from './fixtures'

const utf8 = (text: string) => new TextEncoder().encode(text)

test('rasterizes a safe original to an inert static PNG at the resolved size', async () => {
    const result = await rasterizeDesktopSvg(utf8(SAFE_RED_CIRCLE))
    expect(result.contentType).toBe('image/png')
    expect(result.width).toBe(100)
    expect(result.height).toBe(100)
    expect(result.frames).toBe(1)
    expect(result.animated).toBe(false)
    expect(result.bytes.byteLength).toBeGreaterThan(0)

    const meta = await sharp(result.bytes).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(100)
    expect(meta.height).toBe(100)
})

test('keeps transparency in the rendered PNG', async () => {
    const result = await rasterizeDesktopSvg(utf8(SAFE_TRANSPARENT))
    const meta = await sharp(result.bytes).metadata()
    expect(meta.format).toBe('png')
    expect(meta.hasAlpha).toBe(true)
})

test('renders oversized originals at the bounded output size', async () => {
    const result = await rasterizeDesktopSvg(utf8(SAFE_BIG))
    expect(result.width).toBe(4096)
    expect(result.height).toBe(4096)
})

test('downscales and retries when a rendered PNG exceeds the 8 MB response ceiling', async () => {
    const result = await rasterizeDesktopSvg(utf8(SAFE_NOISE))
    expect(result.contentType).toBe('image/png')
    expect(result.bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024)
    // The initial 2048×2048 noise render is too large, so the retry loop must have halved it.
    expect(result.width).toBeGreaterThan(0)
    expect(result.width).toBeLessThan(2048)
    const meta = await sharp(result.bytes).metadata()
    expect(meta.format).toBe('png')
})

test('rasterization rejects hostile documents with the same reasons as inspection', async () => {
    await expect(rasterizeDesktopSvg(utf8(HOSTILE_SCRIPT))).rejects.toMatchObject({ reason: 'unsupported', detail: 'script' })
})
