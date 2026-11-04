import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }))
vi.mock('node:http', () => ({ request: mocks.request }))
vi.mock('node:https', () => ({ request: mocks.request }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
import { abortable, MAX_BYTES, readPublicPage } from './transport.js'
function reply(status: number, headers: Record<string, string>, chunks: Buffer[] = []) {
    mocks.request.mockImplementationOnce((options, callback) => {
        const req = new EventEmitter() as EventEmitter & { end: () => void }
        req.end = () => {
            const response = Object.assign(Readable.from(chunks), { statusCode: status, headers })
            callback(response)
        }
        return req
    })
}
const signal = () => new AbortController().signal
beforeEach(() => {
    vi.resetAllMocks()
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
})
describe('bounded transport with mocked sockets, no network', () => {
    it('connects directly to checked IP with original TLS name and Host', async () => {
        reply(200, { 'content-type': 'text/plain' }, [Buffer.from('ok')])
        expect((await readPublicPage('https://example.com/', signal(), async () => {})).body).toBe('ok')
        expect(mocks.request.mock.calls[0][0]).toMatchObject({ hostname: '8.8.8.8', servername: 'example.com', rejectUnauthorized: true, checkServerIdentity: expect.any(Function), agent: false, headers: { Host: 'example.com', 'Accept-Encoding': 'identity' } })
        expect(mocks.lookup).toHaveBeenCalledTimes(1)
    })
    it('rejects private redirect destinations before connecting again', async () => {
        reply(302, { location: 'http://127.0.0.1/private' })
        await expect(readPublicPage('https://example.com/', signal(), async () => {})).rejects.toThrow('public addresses')
        expect(mocks.request).toHaveBeenCalledTimes(1)
    })
    it('rejects mixed DNS answers', async () => {
        mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])
        await expect(readPublicPage('https://example.com/', signal(), async () => {})).rejects.toThrow()
        expect(mocks.request).not.toHaveBeenCalled()
    })
    it('enforces bytes on chunked responses without trusting Content-Length', async () => {
        reply(200, { 'content-type': 'text/plain' }, [Buffer.alloc(MAX_BYTES), Buffer.from('x')])
        await expect(readPublicPage('https://example.com/', signal(), async () => {})).rejects.toThrow('byte limit')
    })
    it('refuses arbitrary binary downloads', async () => {
        reply(200, { 'content-type': 'application/octet-stream' })
        await expect(readPublicPage('https://example.com/', signal(), async () => {})).rejects.toThrow('content type')
    })
    it('limits redirect chains', async () => {
        for (let i = 0; i < 4; i++) reply(302, { location: '/again' })
        await expect(readPublicPage('https://example.com/', signal(), async () => {})).rejects.toThrow('Redirect limit')
        expect(mocks.request).toHaveBeenCalledTimes(4)
    })
    it('does not connect if run is cancelled during DNS', async () => {
        const controller = new AbortController()
        mocks.lookup.mockImplementation(async () => { controller.abort(); return [{ address: '8.8.8.8', family: 4 }] })
        await expect(readPublicPage('https://example.com/', controller.signal, async () => {})).rejects.toThrow()
        expect(mocks.request).not.toHaveBeenCalled()
    })
    it('does not connect if permission is revoked after DNS', async () => {
        const permission = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Permission revoked'))
        await expect(readPublicPage('https://example.com/', signal(), permission)).rejects.toThrow('Permission revoked')
        expect(mocks.request).not.toHaveBeenCalled()
    })
    it('stops DNS waits on cancellation without making a request', async () => {
        const controller = new AbortController()
        let entered!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        mocks.lookup.mockImplementation(() => { entered(); return new Promise(() => {}) })
        const result = readPublicPage('https://example.com/', controller.signal, async () => {})
        const rejected = expect(result).rejects.toThrow('Stopped')
        await started
        controller.abort(new Error('Stopped'))
        await rejected
        expect(mocks.request).not.toHaveBeenCalled()
    })
    it('observes rejection of operations passed an already aborted signal', async () => {
        const controller = new AbortController()
        controller.abort(new Error('Stopped'))
        await expect(abortable(Promise.reject(new Error('Late failure')), controller.signal)).rejects.toThrow('Stopped')
    })

    it('rechecks the same hostname on a redirect rather than reusing a DNS answer', async () => {
        mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
            .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
        reply(302, { location: '/next' })
        await expect(readPublicPage('https://example.com/', signal(), async () => {})).rejects.toThrow('public addresses')
        expect(mocks.lookup).toHaveBeenCalledTimes(2)
        expect(mocks.request).toHaveBeenCalledTimes(1)
    })

})
