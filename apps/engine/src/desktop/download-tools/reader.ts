import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { abortable } from '../web-fetch/transport.js'
import { isPublicAddress, publicDestination, publicUrl } from '../web-fetch/public-url.js'
import { DownloadTooLargeError } from './errors.js'
import { DOWNLOAD_LIMIT_BYTES, DOWNLOAD_REDIRECT_LIMIT } from './limits.js'
import { EXECUTABLE_DOWNLOAD_MESSAGE, isExecutableContentType } from './path.js'
import type { PublicBinaryRead, PublicBinaryReader } from './types.js'

const REDIRECT = new Set([301, 302, 303, 307, 308])

function headerValue(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value
    const text = raw?.trim()
    return text ? text : null
}

function connect(url: URL, destination: { address: string; family: number }, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
            hostname: destination.address,
            family: destination.family,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            servername: isIP(hostname) ? undefined : hostname,
            rejectUnauthorized: true,
            checkServerIdentity: (_peer: string, certificate: PeerCertificate) => checkServerIdentity(hostname, certificate),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            agent: false,
            signal,
            maxHeaderSize: 16_384,
            headers: {
                Host: url.host,
                'User-Agent': 'rerun-engine/1.0',
                Accept: '*/*',
                'Accept-Encoding': 'identity',
            },
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

async function readBody(response: IncomingMessage, signal: AbortSignal): Promise<Uint8Array> {
    const encoding = headerValue(response.headers['content-encoding'])
    if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('Compressed downloads are not supported')
    const declared = headerValue(response.headers['content-length'])
    if (declared) {
        if (!/^\d+$/.test(declared)) throw new Error('Response could not be read')
        const announced = declared.length > 15 ? DOWNLOAD_LIMIT_BYTES + 1 : Number(declared)
        if (announced > DOWNLOAD_LIMIT_BYTES) throw new DownloadTooLargeError(announced)
    }
    const contentType = headerValue(response.headers['content-type'])
    if (isExecutableContentType(contentType)) throw new Error(EXECUTABLE_DOWNLOAD_MESSAGE)
    const abort = () => response.destroy(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []
    let size = 0
    try {
        signal.throwIfAborted()
        for await (const chunk of response) {
            signal.throwIfAborted()
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += buffer.byteLength
            if (size > DOWNLOAD_LIMIT_BYTES) throw new DownloadTooLargeError(size)
            chunks.push(buffer)
        }
        signal.throwIfAborted()
        return Buffer.concat(chunks, size)
    } finally {
        signal.removeEventListener('abort', abort)
        response.destroy()
    }
}

/** Public binary GET. Not the text page reader, and it does not write a file or create `.rerun/pages`. */
export const readPublicBinary: PublicBinaryReader = async (value, signal, assertPermission) => {
    let url = publicUrl(value.href)
    const literal = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) && !isPublicAddress(literal)) throw new Error('Destination does not resolve exclusively to public addresses')
    for (let hop = 0; ; hop++) {
        await abortable(assertPermission(), signal)
        const destination = await abortable(publicDestination(url), signal)
        await abortable(assertPermission(), signal)
        signal.throwIfAborted()
        const response = await abortable(connect(url, destination, signal), signal)
        response.on('error', () => {})
        const status = response.statusCode ?? 0
        const location = headerValue(response.headers.location)
        if (REDIRECT.has(status) && location) {
            response.destroy()
            if (hop >= DOWNLOAD_REDIRECT_LIMIT) throw new Error('Redirect limit exceeded')
            url = publicUrl(new URL(location, url).href)
            continue
        }
        const contentType = headerValue(response.headers['content-type'])
        if (status < 200 || status >= 300) {
            response.destroy()
            return { status, finalUrl: url.href, contentType, bytes: new Uint8Array() }
        }
        try {
            const bytes = await readBody(response, signal)
            await abortable(assertPermission(), signal)
            signal.throwIfAborted()
            return { status, finalUrl: url.href, contentType, bytes }
        } finally {
            response.destroy()
        }
    }
}
