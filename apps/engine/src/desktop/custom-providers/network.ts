import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { CustomProviderConfig } from '@rerun/contracts'
import { customModelCatalog } from './catalog.js'

const privateIps = new BlockList()
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['192.0.2.0',24],['198.51.100.0',24],['203.0.113.0',24],['198.18.0.0',15],['224.0.0.0',3]] as const) privateIps.addSubnet(ip,prefix,'ipv4')
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6')
const reserved6 = new BlockList(); reserved6.addSubnet('2001::',23,'ipv6'); reserved6.addSubnet('2001:db8::',32,'ipv6'); reserved6.addSubnet('2002::',16,'ipv6'); reserved6.addSubnet('3fff::',20,'ipv6')
export function endpointBase(config: CustomProviderConfig) {
    const url = new URL(config.baseUrl.trim().replace(/\/+$/, ''))
    if (url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol) || url.origin !== new URL(config.policy.reviewedOrigin).origin || url.protocol === 'http:' && !config.policy.allowHttp) throw new Error('Custom endpoint policy refused.')
    return url.toString().replace(/\/+$/, '')
}
export function addressAllowed(address: string, allowPrivate: boolean) {
    const family = isIP(address)
    if (family === 4) {
        if (/^(0\.|169\.254\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(address)) return false
        return allowPrivate || !privateIps.check(address, 'ipv4')
    }
    if (family !== 6 || address.includes('%') || address.toLowerCase().startsWith('::ffff:')) return false
    if (/^(ff|fe[89ab])/i.test(address) || address === '::') return false
    return allowPrivate || global6.check(address, 'ipv6') && !reserved6.check(address, 'ipv6')
}
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new Error('Custom request cancelled.'))
        signal.addEventListener('abort', aborted, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    })
}
export function createPinnedProviderFetch(config: CustomProviderConfig, current: (signal: AbortSignal) => Promise<void>, lifetime: AbortSignal): typeof fetch {
    const base = endpointBase(config)
    const catalogUrl = customModelCatalog(base).url
    return async (input, init) => {
        const value = input instanceof Request ? input.url : String(input)
        if (input instanceof Request) throw new Error('Custom endpoint requires explicit request options.')
        if (value !== catalogUrl && value !== `${base}/chat/completions`) throw new Error('Custom endpoint request refused.')
        const url = new URL(value), signal = AbortSignal.any([lifetime, init?.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
        await current(signal); signal.throwIfAborted()
        const host = url.hostname.replace(/^\[|\]$/g, '')
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await cancellable(lookup(host, { all: true }), signal)
        await current(signal); signal.throwIfAborted()
        if (!addresses.length || addresses.some(row => !addressAllowed(row.address, config.policy.allowPrivate))) throw new Error('Custom endpoint address refused.')
        const address = addresses[0]
        const body = typeof init?.body === 'string' ? Buffer.from(init.body) : undefined
        if (init?.body && !body || body && body.length > 2_000_000) throw new Error('Custom request exceeds limit.')
        const headers = new Headers(init?.headers)
        const allowed: Record<string,string> = { Accept: 'application/json, text/event-stream', 'Accept-Encoding': 'identity' }
        for (const key of ['authorization','content-type']) { const value = headers.get(key); if (value) allowed[key] = value }
        if (body) allowed['Content-Length'] = String(body.length)
        return new Promise<Response>((resolve, reject) => {
            const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: init?.method ?? 'GET', signal, family: address.family, headers: allowed, agent: false,
                lookup: ((_host: unknown, _opts: unknown, done: (e: null, ip: string, family: number) => void) => done(null, address.address, address.family)) as RequestOptions['lookup'],
            }, response => {
                if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) { response.destroy(); reject(new Error('Custom endpoint redirect refused.')); return }
                if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
                    response.destroy()
                    resolve(Response.json({ error: { message: 'Custom endpoint refused request.' } }, { status: response.statusCode ?? 502 }))
                    return
                }
                if (response.statusCode === 204 || response.statusCode === 205) { response.destroy(); resolve(new Response(null, { status: response.statusCode })); return }
                let count = 0
                const raw = Readable.toWeb(response) as ReadableStream<Uint8Array>
                const reader = raw.getReader()
                const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
                    try {
                        signal.throwIfAborted(); await current(signal)
                        const next = await reader.read()
                        signal.throwIfAborted(); await current(signal)
                        if (next.done) { reader.releaseLock(); controller.close(); return }
                        count += next.value.byteLength
                        if (count > (value === catalogUrl ? 512_000 : 16_000_000)) throw new Error('Custom response exceeds limit.')
                        controller.enqueue(next.value)
                    } catch { await reader.cancel().catch(() => {}); controller.error(new Error('Custom response unavailable or cancelled.')) }
                }, cancel: () => reader.cancel() })
                resolve(new Response(stream, { status: response.statusCode ?? 502, headers: { 'content-type': response.headers['content-type'] ?? 'application/octet-stream' } }))
            })
            req.on('error', () => reject(new Error('Custom endpoint unavailable or cancelled.')))
            req.end(body)
        })
    }
}
