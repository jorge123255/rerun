import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }))
vi.mock('node:http', () => ({ request: mocks.request }))
vi.mock('node:https', () => ({ request: mocks.request }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))

import { DownloadTooLargeError } from './errors.js'
import { readPublicBinary } from './reader.js'

// Authored for the integration owner. This lane does not run them. Sockets and DNS are mocked.
function reply(status: number, headers: Record<string, string | undefined>, chunks: Buffer[] = []) {
    mocks.request.mockImplementationOnce((_options, callback) => {
        const req = new EventEmitter() as EventEmitter & { end: () => void; on: EventEmitter['on'] }
        req.end = () => {
            const response = Object.assign(Readable.from(chunks), { statusCode: status, headers })
            callback(response)
        }
        return req
    })
}

const signal = () => new AbortController().signal
const allow = async () => {}

beforeEach(() => {
    vi.resetAllMocks()
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
})

describe('public binary reader', () => {
    it('connects to the admitted address and returns the bytes', async () => {
        reply(200, { 'content-type': 'application/octet-stream' }, [Buffer.from([0, 1, 2, 255])])
        const result = await readPublicBinary(new URL('https://example.com/a.bin'), signal(), allow)
        expect([...result.bytes]).toEqual([0, 1, 2, 255])
        expect(result.status).toBe(200)
        expect(mocks.request.mock.calls[0][0]).toMatchObject({
            hostname: '8.8.8.8', servername: 'example.com', agent: false, method: 'GET',
            headers: { Host: 'example.com', Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'rerun-engine/1.0' },
        })
        expect(mocks.lookup).toHaveBeenCalledTimes(1)
    })

    it('does not follow a redirect to a private address', async () => {
        reply(302, { location: 'http://127.0.0.1/private' })
        await expect(readPublicBinary(new URL('https://example.com/a.bin'), signal(), allow)).rejects.toThrow('public addresses')
        expect(mocks.request).toHaveBeenCalledTimes(1)
    })

    it('refuses a private literal before connecting', async () => {
        await expect(readPublicBinary(new URL('http://127.0.0.1/a.bin'), signal(), allow)).rejects.toThrow('public addresses')
        expect(mocks.request).not.toHaveBeenCalled()
        expect(mocks.lookup).not.toHaveBeenCalled()
    })

    it('returns an HTTP error without the body', async () => {
        reply(404, { 'content-type': 'text/plain' }, [Buffer.from('secret')])
        const result = await readPublicBinary(new URL('https://example.com/missing.bin'), signal(), allow)
        expect(result.status).toBe(404)
        expect(result.bytes.byteLength).toBe(0)
    })

    it('stops before an executable body', async () => {
        reply(200, { 'content-type': 'application/x-mach-binary' }, [Buffer.from([0xcf, 0xfa])])
        await expect(readPublicBinary(new URL('https://example.com/a.bin'), signal(), allow)).rejects.toThrow('can’t be downloaded')
    })

    it('refuses a declared body over 50 MB', async () => {
        reply(200, { 'content-type': 'application/octet-stream', 'content-length': '50000001' })
        await expect(readPublicBinary(new URL('https://example.com/huge.bin'), signal(), allow)).rejects.toBeInstanceOf(DownloadTooLargeError)
    })
})
