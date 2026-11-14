import 'server-only'
import { request } from 'node:https'
import type { RequestOptions } from 'node:https'
import { Readable } from 'node:stream'
import { publicOAuthAddress } from '../mcp/oauth-network'
import type { McpNetwork } from '../mcp/remote'

// A workspace connector must stay on its approved public HTTPS destination, including
// after DNS resolution. The native client does not follow redirects or use a proxy.
export const vaultMcpHttps: McpNetwork = async (input, init, guard) => {
    const url = new URL(String(input))
    const { signal, method, headers, body } = init
    const address = await publicOAuthAddress(url.href, signal)
    await guard()
    signal.throwIfAborted()
    return new Promise<Response>((resolve, reject) => {
        const options = {
            method, signal, headers: Object.fromEntries(new Headers(headers)), agent: false as const, family: address.family, autoSelectFamily: false,
            lookup: ((_host: unknown, _options: unknown, done: (error: null, address: string, family: number) => void) => done(null, address.address, address.family)) as RequestOptions['lookup'],
        }
        const req = request(url, options, res => {
            const responseHeaders = new Headers()
            for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1])
            const status = res.statusCode ?? 500
            const hasBody = ![204, 205, 304].includes(status)
            if (!hasBody) res.resume()
            res.on('error', () => {})
            try { resolve(new Response(hasBody ? Readable.toWeb(res) as ReadableStream<Uint8Array> : null, { status, headers: responseHeaders })) }
            catch (error) { res.destroy(); reject(error) }
        })
        req.on('error', () => reject(new Error('Vault MCP connection unavailable')))
        req.end(body)
    })
}
