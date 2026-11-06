import 'server-only'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import type { RequestOptions } from 'node:http'
import { oauthHttps, publicOAuthAddress } from '../../mcp/oauth-network'
import type { AccountNetwork } from '../accounts/transport'
export const pinnedOAuthAccountNetwork: AccountNetwork = async (value, init) => {
    const signal = init.signal ?? AbortSignal.timeout(20_000), url = oauthHttps(value)
    const address = await publicOAuthAddress(url.href, signal)
    signal.throwIfAborted()
    const body = typeof init.body === 'string' ? init.body : undefined
    if (init.body != null && body === undefined || body && Buffer.byteLength(body) > 65_536) throw new Error('Invalid OAuth account request.')
    const headers = Object.fromEntries(new Headers(init.headers))
    return new Promise<Response>((resolve, reject) => {
        const options = { method: init.method, signal, agent: false as const, family: address.family, autoSelectFamily: false, maxHeaderSize: 16_384,
            lookup: ((_host: unknown, _options: unknown, done: (error: null, address: string, family: number) => void) => done(null, address.address, address.family)) as RequestOptions['lookup'], headers: { ...headers, 'Accept-Encoding': 'identity' } }
        const req = request(url, options, response => {
            const responseHeaders = new Headers()
            for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value)
            response.on('error', () => {})
            const status = response.statusCode ?? 502
            if (status < 200 || status > 599) { response.destroy(); reject(new Error('OAuth account response unavailable.')); return }
            if (status === 204 || status === 304) { response.resume(); resolve(new Response(null, { status, headers: responseHeaders })); return }
            resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }))
        })
        req.on('error', () => { req.destroy(); reject(new Error('OAuth account connection unavailable.')) })
        req.end(body)
    })
}
