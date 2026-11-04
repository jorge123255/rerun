import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { publicDestination, publicUrl } from './public-url'

export const MAX_BYTES = 1_000_000
export const MAX_REDIRECTS = 3
export const DEADLINE_MS = 30_000
export type PublicPage = { url: string; status: number; contentType: string; xRobotsTag: string | null; body: string; bytes: number }

// Bounds every awaited operation, including DNS and permission reads. The OS DNS request may
// finish later, but cannot start a connection after this race has been cancelled.
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('Cancelled'))
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}

function connect(url: URL, destination: { address: string; family: number }, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        // Direct numeric destination: no second DNS lookup, proxy, cookie jar or pooled socket.
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
            hostname: destination.address, family: destination.family,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            servername: isIP(hostname) ? undefined : hostname,
            // For HTTPS IP literals Node verifies the certificate against the numeric host.
            path: `${url.pathname}${url.search}`, method: 'GET', agent: false, signal,
            maxHeaderSize: 16_384,
            headers: { Host: url.host, 'User-Agent': 'rerun-engine/1.0', Accept: 'text/html, text/plain, application/json, application/xml;q=0.8', 'Accept-Encoding': 'identity' },
        }, resolve)
        req.on('error', reject)
        req.end()
    })
}

export async function readPublicPage(value: string, signal: AbortSignal, assertPermission: () => Promise<void>): Promise<PublicPage> {
    let url = publicUrl(value)
    for (let hop = 0; ; hop++) {
        await abortable(assertPermission(), signal)
        const destination = await abortable(publicDestination(url), signal)
        await abortable(assertPermission(), signal)
        signal.throwIfAborted()
        const response = await connect(url, destination, signal)
        // Keep an error listener even for responses discarded without reading their bodies.
        response.on('error', () => {})
        const status = response.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy()
            if (hop >= MAX_REDIRECTS) throw new Error('Redirect limit exceeded')
            url = publicUrl(new URL(response.headers.location, url).href)
            continue
        }
        const contentType = response.headers['content-type'] ?? ''
        const mime = contentType.split(';')[0].trim().toLowerCase()
        if (!['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/xml', 'text/xml'].includes(mime)) {
            response.destroy()
            throw new Error(`Unsupported content type: ${mime || 'missing'}`)
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy()
            throw new Error('Compressed responses are not supported')
        }
        const declared = response.headers['content-length']
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
            response.destroy()
            throw new Error('Response exceeds byte limit')
        }
        const chunks: Buffer[] = []
        let bytes = 0
        try {
            for await (const chunk of response) {
                signal.throwIfAborted()
                bytes += chunk.length
                if (bytes > MAX_BYTES) throw new Error('Response exceeds byte limit')
                chunks.push(Buffer.from(chunk))
            }
            await abortable(assertPermission(), signal)
            signal.throwIfAborted()
            const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8'
            return { url: url.href, status, contentType, xRobotsTag: String(response.headers['x-robots-tag'] ?? '') || null, body: new TextDecoder(charset).decode(Buffer.concat(chunks)), bytes }
        } finally { response.destroy() }
    }
}
