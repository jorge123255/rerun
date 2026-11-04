import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MAX_BYTES, readTextBody } from './body.js'
function response(chunks: Buffer[], headers: Record<string, string> = { 'content-type': 'text/plain' }): IncomingMessage {
    const stream = Object.assign(Readable.from(chunks), { headers })
    stream.on('error', () => {})
    return stream as unknown as IncomingMessage
}
describe('stream body boundary (offline)', () => {
    it('accepts exactly the byte cap', async () => {
        expect((await readTextBody(response([Buffer.alloc(MAX_BYTES)]), new AbortController().signal)).bytes).toBe(MAX_BYTES)
    })
    it('counts actual bytes when the declared size is smaller', async () => {
        const stream = response([Buffer.alloc(MAX_BYTES), Buffer.from('x')], { 'content-type': 'text/plain', 'content-length': '1' })
        await expect(readTextBody(stream, new AbortController().signal)).rejects.toThrow('byte limit')
        expect(stream.destroyed).toBe(true)
    })
    const refusedHeaders: Record<string, string>[] = [
        { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        { 'content-type': 'application/pdf' },
        {},
        { 'content-type': 'text/plain; charset=unsupported-charset' },
    ]
    it.each(refusedHeaders)('closes refused bodies %j', async headers => {
        const stream = response([], headers)
        await expect(readTextBody(stream, new AbortController().signal)).rejects.toThrow()
        expect(stream.destroyed).toBe(true)
    })
    it('cancels a body which never delivers another chunk', async () => {
        let entered!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        const stream = Object.assign(new Readable({ read() { entered() } }), { headers: { 'content-type': 'text/plain' } })
        stream.on('error', () => {})
        const controller = new AbortController()
        const rejected = expect(readTextBody(stream as unknown as IncomingMessage, controller.signal)).rejects.toThrow('Stopped')
        await started
        controller.abort(new Error('Stopped'))
        await rejected
        expect(stream.destroyed).toBe(true)
    })
})
