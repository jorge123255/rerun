import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type sharpFactory from 'sharp'
import { LOGO_MAX_BYTES, LOGO_TOO_LARGE, NO_LOGO_FOUND } from '../workspace-logo-link'

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn(), sharp: vi.fn(), decode: vi.fn(), destroy: vi.fn() }))
vi.mock('node:http', () => ({ request: mocks.request }))
vi.mock('node:https', () => ({ request: mocks.request }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('sharp', () => ({ default: mocks.sharp }))

import { fetchWorkspaceLogo, LOGO_FETCH_MAX_REDIRECTS } from './workspace-logo-fetch'

// Valid PNG framing/CRCs and readable RGBA metadata, deliberately invalid compressed pixels.
// Transport cases mock decode; the real-decoder regression below must refuse these same bytes.
function pngFixture(): Uint8Array {
    const chunk = (type: string, payload: Buffer) => {
        const content = Buffer.concat([Buffer.from(type, 'ascii'), payload])
        let crc = 0xffffffff
        for (const byte of content) {
            crc ^= byte
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
        }
        const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
        length.writeUInt32BE(payload.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
        return Buffer.concat([length, content, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]))
}

// A RIFF/WEBP container whose VP8X flags carry the animation bit (0x02): image-bytes must refuse
// this before any preview, exactly like the workspace-icon save path.
function animatedWebp(): Uint8Array {
    const vp8x = Buffer.alloc(10)
    vp8x[0] = 0x02
    vp8x.writeUIntBE(1, 4, 3)
    vp8x.writeUIntBE(1, 7, 3)
    const chunk = Buffer.concat([Buffer.from('VP8X', 'ascii'), Buffer.from([10, 0, 0, 0]), vp8x])
    const riff = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), chunk])
    riff.writeUInt32LE(riff.length - 8, 4)
    return new Uint8Array(riff)
}

let lastResponse: { destroyed: boolean } | undefined
function reply(status: number, headers: Record<string, string>, chunks: Buffer[] = []) {
    mocks.request.mockImplementationOnce((options, callback) => {
        const req = new EventEmitter() as EventEmitter & { end: () => void }
        req.end = () => {
            const response = Object.assign(Readable.from(chunks), { statusCode: status, headers })
            lastResponse = response
            callback(response)
        }
        return req
    })
}
const signal = () => new AbortController().signal
const png = () => Buffer.from(pngFixture())

beforeEach(() => {
    vi.resetAllMocks()
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    mocks.decode.mockResolvedValue(Buffer.from([0, 0, 0, 255]))
    mocks.sharp.mockImplementation(() => {
        const decoder = { timeout: vi.fn(), rotate: vi.fn(), resize: vi.fn(), raw: vi.fn(), toBuffer: mocks.decode, destroy: mocks.destroy }
        for (const configure of [decoder.timeout, decoder.rotate, decoder.resize, decoder.raw]) configure.mockReturnValue(decoder)
        return decoder
    })
    lastResponse = undefined
})

describe('bounded logo fetch with mocked sockets, no network', () => {
    it('connects directly to the checked IP with the original TLS name and Host', async () => {
        reply(200, { 'content-type': 'image/png' }, [png()])
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: true, bytes: pngFixture(), contentType: 'image/png' })
        expect(mocks.request.mock.calls[0]![0]).toMatchObject({
            hostname: '8.8.8.8', servername: 'example.com', rejectUnauthorized: true,
            checkServerIdentity: expect.any(Function), agent: false,
            headers: { Host: 'example.com', 'Accept-Encoding': 'identity' },
        })
        expect(mocks.lookup).toHaveBeenCalledTimes(1)
    })

    it('follows the favicon redirect and revalidates every hop before connecting again', async () => {
        reply(302, { location: 'https://cdn.acme.example/favicon.png' })
        reply(200, { 'content-type': 'image/png' }, [png()])
        const result = await fetchWorkspaceLogo('https://www.google.com/s2/favicons?sz=128&domain=acme.com', signal())
        expect(result.ok).toBe(true)
        expect(mocks.lookup).toHaveBeenCalledTimes(2)
        expect(mocks.request).toHaveBeenCalledTimes(2)
        expect(mocks.request.mock.calls[1]![0]).toMatchObject({ hostname: '8.8.8.8', servername: 'cdn.acme.example', headers: { Host: 'cdn.acme.example' } })
    })

    it('rejects a private redirect destination before connecting again', async () => {
        reply(302, { location: 'http://127.0.0.1/logo.png' })
        await expect(fetchWorkspaceLogo('https://example.com/logo.png', signal())).resolves.toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
        expect(mocks.request).toHaveBeenCalledTimes(1)
    })

    it('rejects mixed DNS answers before connecting', async () => {
        mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
        expect(mocks.request).not.toHaveBeenCalled()
    })

    it('refuses a logo larger than 8 MiB without trusting content-length', async () => {
        reply(200, { 'content-type': 'image/png', 'content-length': '1' }, [Buffer.alloc(LOGO_MAX_BYTES), Buffer.from('x')])
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: false, status: 413, error: LOGO_TOO_LARGE })
        expect(lastResponse?.destroyed).toBe(true)
    })

    it.each([
        { 'content-type': 'image/svg+xml' },
        { 'content-type': 'image/gif' },
        { 'content-type': 'image/x-icon' },
        { 'content-type': 'application/octet-stream' },
        {},
    ])('rejects unsupported content type %j with a clear message', async headers => {
        reply(200, headers, [png()])
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: false, status: 415, error: 'Use a PNG, JPEG or WebP image link.' })
    })

    it('rejects an animated WebP before preview', async () => {
        reply(200, { 'content-type': 'image/webp' }, [Buffer.from(animatedWebp())])
        const result = await fetchWorkspaceLogo('https://example.com/logo.webp', signal())
        expect(result).toEqual({ ok: false, status: 415, error: 'Animated images can’t be the workspace icon. Choose a static image.' })
    })

    it('rejects bytes that are not the declared raster', async () => {
        reply(200, { 'content-type': 'image/png' }, [Buffer.from([1, 2, 3, 4])])
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: false, status: 415, error: 'This file is not a supported image.' })
    })

    it('refuses a raster sharp cannot decode', async () => {
        mocks.decode.mockRejectedValue(new Error('Invalid pixel data'))
        reply(200, { 'content-type': 'image/png' }, [png()])
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: false, status: 415, error: 'This image is damaged and can’t be used.' })
    })

    it('forces a real decode, rejecting framed PNG bytes whose metadata is readable but pixels are corrupt', async () => {
        const { default: sharp } = await vi.importActual<{ default: typeof sharpFactory }>('sharp')
        expect((await sharp(png()).metadata()).format).toBe('png')
        mocks.sharp.mockImplementationOnce(sharp)
        reply(200, { 'content-type': 'image/png' }, [png()])
        expect(await fetchWorkspaceLogo('https://example.com/logo.png', signal())).toEqual({ ok: false, status: 415, error: 'This image is damaged and can’t be used.' })
    })

    it('fully decodes a real image but returns the exact original bytes for atomic Save', async () => {
        const { default: sharp } = await vi.importActual<{ default: typeof sharpFactory }>('sharp')
        const original = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#abcdef' } }).png().toBuffer()
        mocks.sharp.mockImplementationOnce(sharp)
        reply(200, { 'content-type': 'image/png' }, [original])
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: true, bytes: new Uint8Array(original), contentType: 'image/png' })
        expect(mocks.sharp).toHaveBeenCalledWith(expect.any(Buffer), { limitInputPixels: 16_777_216, failOn: 'warning' })
    })

    it('aborts a pending decode and never publishes its late success', async () => {
        let entered!: () => void, complete!: (pixels: Buffer) => void
        const started = new Promise<void>(resolve => { entered = resolve })
        mocks.decode.mockImplementationOnce(() => { entered(); return new Promise<Buffer>(resolve => { complete = resolve }) })
        reply(200, { 'content-type': 'image/png' }, [png()])
        const stop = new AbortController()
        const result = fetchWorkspaceLogo('https://example.com/logo.png', stop.signal)
        await started
        stop.abort()
        expect(await result).toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
        expect(mocks.destroy).toHaveBeenCalled()
        complete(Buffer.from([0, 0, 0, 255]))
        await Promise.resolve()
        expect(lastResponse?.destroyed).toBe(true)
    })

    it('refuses private and local targets without a request', async () => {
        for (const value of ['http://localhost/logo.png', 'https://user:pass@example.com/logo.png',
            'http://example.com:7070/logo.png', 'http://example.com./logo.png', 'https://metadata.internal/logo.png']) {
            const result = await fetchWorkspaceLogo(value, signal())
            expect(result).toEqual({ ok: false, status: 400, error: NO_LOGO_FOUND })
        }
        // Literal loopback passes the URL checks but fails the validated destination policy.
        for (const value of ['http://127.0.0.1/logo.png', 'http://[::1]/logo.png', 'http://10.0.0.1/logo.png']) {
            const result = await fetchWorkspaceLogo(value, signal())
            expect(result).toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
        }
        expect(mocks.request).not.toHaveBeenCalled()
        expect(mocks.lookup).not.toHaveBeenCalled()
    })

    it('limits redirect chains', async () => {
        for (let i = 0; i <= LOGO_FETCH_MAX_REDIRECTS; i++) reply(302, { location: '/again' })
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', signal())
        expect(result).toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
        expect(mocks.request).toHaveBeenCalledTimes(LOGO_FETCH_MAX_REDIRECTS + 1)
    })

    it('maps upstream HTTP failures to no-logo-found', async () => {
        reply(404, { 'content-type': 'text/html' }, [Buffer.from('missing')])
        expect(await fetchWorkspaceLogo('https://example.com/logo.png', signal())).toEqual({ ok: false, status: 404, error: NO_LOGO_FOUND })
        reply(500, { 'content-type': 'text/html' }, [Buffer.from('boom')])
        expect(await fetchWorkspaceLogo('https://example.com/logo.png', signal())).toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
    })

    it('does not connect if the deadline aborts during DNS', async () => {
        const controller = new AbortController()
        mocks.lookup.mockImplementation(async () => { controller.abort(); return [{ address: '8.8.8.8', family: 4 }] })
        const result = await fetchWorkspaceLogo('https://example.com/logo.png', controller.signal)
        expect(result).toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
        expect(mocks.request).not.toHaveBeenCalled()
    })

    it('destroys the transport when the deadline aborts a stalled body', async () => {
        let entered!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        mocks.request.mockImplementationOnce((options, callback) => {
            const req = new EventEmitter() as EventEmitter & { end: () => void }
            req.end = () => {
                const response = Object.assign(new Readable({ read() { entered() } }), { statusCode: 200, headers: { 'content-type': 'image/png' } })
                response.on('error', () => {})
                lastResponse = response
                callback(response)
            }
            return req
        })
        const controller = new AbortController()
        const result = fetchWorkspaceLogo('https://example.com/logo.png', controller.signal)
        await started
        controller.abort(new Error('Stopped'))
        expect(await result).toEqual({ ok: false, status: 502, error: NO_LOGO_FOUND })
        expect(lastResponse?.destroyed).toBe(true)
    })
})
