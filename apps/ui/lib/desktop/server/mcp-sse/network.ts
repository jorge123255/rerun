import 'server-only'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { RequestOptions } from 'node:http'
import { DESKTOP_MCP_SSE_LIMITS as L } from '@rerun/contracts'
import { SseFailure, deferred, wait } from './errors'
import type { SseAuthority, SseNetwork, SseWireResponse } from './types'

export type SseNetworkBoundary = {
    resolvePublic(url: string, signal: AbortSignal): Promise<{ address: string; family: number }>
    credential(authority: SseAuthority, signal: AbortSignal): Promise<{ bearer?: string }>
}

export function createPinnedSseNetwork(boundary: SseNetworkBoundary): SseNetwork {
    return async input => {
        const url = new URL(input.url)
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || input.body && Buffer.byteLength(input.body) > L.requestBytes) throw new SseFailure('unsupported')
        await input.guard()
        const address = await wait(boundary.resolvePublic(url.href, input.signal), input.signal)
        if (!isIP(address.address) || isIP(address.address) !== address.family) throw new SseFailure('unsupported')
        const credential = await wait(boundary.credential(input.authority, input.signal), input.signal)
        if (credential.bearer !== undefined && !/^[\x21-\x7e]{1,8192}$/.test(credential.bearer)) throw new SseFailure('auth-needed')
        await input.guard(); input.signal.throwIfAborted()
        return new Promise<SseWireResponse>((resolve, reject) => {
            const reqClosed = deferred<void>()
            const options = {
                method: input.method, signal: input.signal, agent: false as const, family: address.family, autoSelectFamily: false,
                lookup: ((_host: unknown, _options: unknown, done: (error: null, address: string, family: number) => void) => done(null, address.address, address.family)) as RequestOptions['lookup'],
                maxHeaderSize: 16_384,
                headers: { Accept: input.method === 'GET' ? 'text/event-stream' : 'application/json',
                    'Accept-Encoding': 'identity', ...(input.body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(input.body)) } : {}),
                    ...(credential.bearer ? { Authorization: `Bearer ${credential.bearer}` } : {}) },
            }
            // Native HTTPS neither follows redirects nor re-resolves after the pinned lookup.
            const req = httpsRequest(url, options, response => {
                const resClosed = deferred<void>()
                response.once('close', () => resClosed.resolve())
                response.on('error', () => {})
                resolve({ status: response.statusCode ?? 0, contentType: String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
                    body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
                    async close(signal: AbortSignal) {
                        response.destroy(); req.destroy()
                        await wait(Promise.all([reqClosed.promise, resClosed.promise]).then(() => undefined), signal)
                    },
                })
            })
            req.once('close', () => reqClosed.resolve())
            req.on('error', () => { req.destroy(); void reqClosed.promise.then(() => reject(new SseFailure('unavailable'))) })
            req.end(input.body)
        })
    }
}
