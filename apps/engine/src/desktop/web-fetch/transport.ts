import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { readTextBody } from './body.ts'
import { publicDestination, publicUrl } from './public-url.ts'
export { MAX_BYTES } from './body.ts'

export const MAX_REDIRECTS = 3
export const DEADLINE_MS = 30_000
export type PublicPage = { url: string; status: number; contentType: string; xRobotsTag: string | null; body: string; bytes: number }

export class PageReadError extends Error {
    constructor(message: string, readonly status: number, readonly finalUrl: string) {
        super(message)
        this.name = 'PageReadError'
    }
}

// Bounds waits including DNS and permission reads; late completion cannot resume a cancelled run.
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort)
            reject(signal.reason ?? new Error('Cancelled'))
        }
        // Attach both handlers even if already aborted: the supplied operation may still reject.
        promise.then(value => {
            signal.removeEventListener('abort', abort)
            resolve(value)
        }, error => {
            signal.removeEventListener('abort', abort)
            reject(error)
        })
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
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
            // Pin certificate verification to the original identity, not the numeric peer.
            rejectUnauthorized: true,
            checkServerIdentity: (_peer: string, certificate: PeerCertificate) => checkServerIdentity(hostname, certificate),
            path: `${url.pathname}${url.search}`, method: 'GET', agent: false, signal,
            maxHeaderSize: 16_384,
            headers: { Host: url.host, 'User-Agent': 'rerun-engine/1.0', Accept: 'text/html, text/plain, application/json, application/xml;q=0.8', 'Accept-Encoding': 'identity' },
        }, response => {
            if (signal.aborted) {
                response.on('error', () => {})
                response.destroy()
                reject(signal.reason ?? new Error('Cancelled'))
            } else resolve(response)
        })
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
        const response = await abortable(connect(url, destination, signal), signal)
        // Keep an error listener even for responses discarded without reading their bodies.
        response.on('error', () => {})
        const status = response.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy()
            if (hop >= MAX_REDIRECTS) throw new Error('Redirect limit exceeded')
            url = publicUrl(new URL(response.headers.location, url).href)
            continue
        }
        try {
            const page = await readTextBody(response, signal)
            await abortable(assertPermission(), signal)
            signal.throwIfAborted()
            return { url: url.href, status, xRobotsTag: String(response.headers['x-robots-tag'] ?? '') || null, ...page }
        } catch (error) {
            throw new PageReadError(error instanceof Error ? error.message : 'Response could not be read', status, url.href)
        } finally { response.destroy() }
    }
}
