import 'server-only'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { LOGO_MAX_BYTES, LOGO_TOO_LARGE, NO_LOGO_FOUND } from '../workspace-logo-link'
import { DESKTOP_IMAGE_MAX_PIXELS, DesktopImageBytesError, inspectDesktopImageBytes, type DesktopRasterKind } from './image-bytes'

export const LOGO_FETCH_MAX_REDIRECTS = 3
// One deadline bounds DNS, every redirect revalidation and the body read; a late result cannot
// resume a cancelled preview, and cancellation destroys the open transport.
export const LOGO_FETCH_DEADLINE_MS = 10_000

export type WorkspaceLogoFetchResult =
    | { ok: true; bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/webp' }
    | { ok: false; status: number; error: string }

// The desktop web-fetch policy, mirrored verbatim from apps/engine/src/desktop/web-fetch/public-url.ts:
// only public http(s), no credentials, only ports 80/443, and no local/internal/trailing-dot hosts.
const blocked = new BlockList()
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6')

function isPublicAddress(address: string): boolean {
    const family = isIP(address)
    // IPv4 mapped, NAT64, compatible and scoped IPv6 are deliberately excluded.
    return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

function publicUrl(value: string): URL {
    if (value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid URL')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without credentials are allowed')
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Only HTTP(S) ports 80 and 443 are allowed')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host.endsWith('.') || host === 'localhost' || /\.(localhost|local|internal|home|lan|test|invalid|onion)$/.test(host)) throw new Error('Not a public host')
    url.hash = ''
    return url
}

async function publicDestination(url: URL): Promise<{ address: string; family: number }> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const family = isIP(hostname)
    const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true })
    if (!addresses.length || !addresses.every(row => isPublicAddress(row.address))) throw new Error('Destination does not resolve exclusively to public addresses')
    return addresses[0]
}

// Bounds waits including DNS; late completion cannot resume a cancelled preview.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort)
            reject(signal.reason ?? new Error('Cancelled'))
        }
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
            headers: { Host: url.host, 'User-Agent': 'rerun-desktop/1.0', Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' },
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

const LOGO_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const LOGO_KIND: Record<string, DesktopRasterKind> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }

class WorkspaceLogoError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'WorkspaceLogoError'
    }
}

function logoImageError(error: DesktopImageBytesError): WorkspaceLogoError {
    if (error.reason === 'dimensions') return new WorkspaceLogoError(413, 'This image is too large to use as the workspace icon.')
    if (error.reason === 'mismatch') return new WorkspaceLogoError(415, 'This file is not a supported image.')
    if (error.reason === 'animation') return new WorkspaceLogoError(415, 'Animated images can’t be the workspace icon. Choose a static image.')
    return new WorkspaceLogoError(415, 'This image is damaged and can’t be used.')
}

// Metadata alone does not decode pixel data. Force the same bounded raster decode as Save, with
// a small raw output; return the reviewed original bytes, never the derivative used for validation.
async function decodeWithSharp(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const { default: sharp } = await abortable(import('sharp'), signal)
    signal.throwIfAborted()
    const decoder = sharp(Buffer.from(bytes), { limitInputPixels: DESKTOP_IMAGE_MAX_PIXELS, failOn: 'warning' })
        .timeout({ seconds: LOGO_FETCH_DEADLINE_MS / 1000 })
        .rotate().resize(256, 256, { fit: 'inside', withoutEnlargement: true }).raw()
    const abort = () => { decoder.destroy() }
    signal.addEventListener('abort', abort, { once: true })
    try {
        signal.throwIfAborted()
        await abortable(decoder.toBuffer(), signal)
        signal.throwIfAborted()
    } catch (error) {
        if (signal.aborted) throw error
        throw new WorkspaceLogoError(415, 'This image is damaged and can’t be used.')
    } finally {
        signal.removeEventListener('abort', abort)
        decoder.destroy()
    }
}

// Cancellation destroys the stream even when it has stopped delivering chunks. Never buffer the
// entire response before checking its actual byte count, or trust Content-Length alone.
async function readLogoBody(response: IncomingMessage, signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/webp' }> {
    const abort = () => response.destroy(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    try {
        signal.throwIfAborted()
        const contentType = response.headers['content-type'] ?? ''
        const mime = contentType.split(';')[0].trim().toLowerCase()
        const kind = LOGO_KIND[mime]
        if (!kind || !LOGO_CONTENT_TYPES.has(mime)) throw new WorkspaceLogoError(415, 'Use a PNG, JPEG or WebP image link.')
        if (response.headers['content-encoding'] && response.headers['content-encoding'].trim().toLowerCase() !== 'identity') {
            throw new WorkspaceLogoError(415, 'Use a PNG, JPEG or WebP image link.')
        }
        const declared = response.headers['content-length']
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > LOGO_MAX_BYTES)) throw new WorkspaceLogoError(413, LOGO_TOO_LARGE)
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of response) {
            signal.throwIfAborted()
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bytes += buffer.byteLength
            if (bytes > LOGO_MAX_BYTES) throw new WorkspaceLogoError(413, LOGO_TOO_LARGE)
            chunks.push(buffer)
        }
        signal.throwIfAborted()
        const raw = new Uint8Array(Buffer.concat(chunks, bytes))
        try {
            inspectDesktopImageBytes(kind, raw)
        } catch (error) {
            if (error instanceof DesktopImageBytesError) throw logoImageError(error)
            throw new WorkspaceLogoError(415, 'This image is damaged and can’t be used.')
        }
        await decodeWithSharp(raw, signal)
        signal.throwIfAborted()
        return { bytes: raw, contentType: mime as 'image/png' | 'image/jpeg' | 'image/webp' }
    } finally {
        signal.removeEventListener('abort', abort)
        response.destroy()
    }
}

// Downloads the image a logo link points at through the desktop web-fetch policy: public http(s)
// only, every redirect revalidated against fresh DNS, one deadline across DNS + redirects + body,
// at most LOGO_MAX_BYTES of actual bytes, and a static PNG/JPEG/WebP raster or a clear refusal.
export async function fetchWorkspaceLogo(value: string, signal: AbortSignal): Promise<WorkspaceLogoFetchResult> {
    let url: URL
    try { url = publicUrl(value) } catch { return { ok: false, status: 400, error: NO_LOGO_FOUND } }
    for (let hop = 0; ; hop++) {
        let destination: { address: string; family: number }
        try { destination = await abortable(publicDestination(url), signal) } catch {
            return { ok: false, status: 502, error: NO_LOGO_FOUND }
        }
        let response: IncomingMessage
        try {
            signal.throwIfAborted()
            response = await abortable(connect(url, destination, signal), signal)
        } catch {
            return { ok: false, status: 502, error: NO_LOGO_FOUND }
        }
        // Keep an error listener even for responses discarded without reading their bodies.
        response.on('error', () => {})
        const status = response.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy()
            if (hop >= LOGO_FETCH_MAX_REDIRECTS) return { ok: false, status: 502, error: NO_LOGO_FOUND }
            try { url = publicUrl(new URL(response.headers.location, url).href) } catch {
                return { ok: false, status: 502, error: NO_LOGO_FOUND }
            }
            continue
        }
        if (status >= 400) {
            response.destroy()
            return { ok: false, status: status >= 500 ? 502 : 404, error: NO_LOGO_FOUND }
        }
        try {
            const body = await readLogoBody(response, signal)
            return { ok: true, bytes: body.bytes, contentType: body.contentType }
        } catch (error) {
            if (error instanceof WorkspaceLogoError) return { ok: false, status: error.status, error: error.message }
            return { ok: false, status: 502, error: NO_LOGO_FOUND }
        }
    }
}
