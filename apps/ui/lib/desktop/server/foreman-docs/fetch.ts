import 'server-only'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { DESKTOP_FOREMAN_DOCS_LIMITS, RERUN_PUBLIC_DOCS_CORPUS, type DesktopForemanDocsCorpus } from '@rerun/contracts'
import { publicDestination } from '../../../../../engine/src/desktop/web-fetch/public-url.ts'
import { abortable } from '../../../../../engine/src/desktop/web-fetch/transport.ts'
import { readTextBody } from '../../../../../engine/src/desktop/web-fetch/body.ts'

export function assertDesktopForemanDocsUrl(value: string): URL {
    const url = new URL(value)
    const expected = new URL(RERUN_PUBLIC_DOCS_CORPUS.exportUrl)
    if (url.protocol !== 'https:' || url.hostname !== expected.hostname || url.port || url.username || url.password || url.pathname !== expected.pathname || url.search || url.hash) throw new Error('Documentation URL is not allowlisted.')
    return url
}

function connect(url: URL, destination: { address: string; family: number }, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const req = httpsRequest({
            hostname: destination.address,
            family: destination.family,
            port: 443,
            servername: url.hostname,
            rejectUnauthorized: true,
            checkServerIdentity: (_peer: string, certificate: PeerCertificate) => checkServerIdentity(url.hostname, certificate),
            path: url.pathname,
            method: 'GET',
            agent: false,
            signal,
            maxHeaderSize: 16_384,
            headers: { Host: url.host, 'User-Agent': 'rerun-desktop/1.0', Accept: 'text/plain', 'Accept-Encoding': 'identity' },
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

export type DesktopForemanDocsFetchResult = { body: string; byteLength: number; version: string }

export async function readDesktopForemanDocsCorpus(corpus: DesktopForemanDocsCorpus, signal: AbortSignal, assertLive: () => Promise<void>): Promise<DesktopForemanDocsFetchResult> {
    let url = assertDesktopForemanDocsUrl(corpus.exportUrl)
    for (let hop = 0; ; hop++) {
        await abortable(assertLive(), signal)
        const destination = await abortable(publicDestination(url), signal)
        await abortable(assertLive(), signal)
        signal.throwIfAborted()
        const response = await abortable(connect(url, destination, signal), signal)
        response.on('error', () => {})
        const status = response.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy()
            if (hop >= DESKTOP_FOREMAN_DOCS_LIMITS.maxRedirects) throw new Error('Documentation redirect limit exceeded.')
            url = assertDesktopForemanDocsUrl(new URL(response.headers.location, url).href)
            continue
        }
        try {
            const page = await readTextBody(response, signal)
            assertDesktopForemanDocsUrl(url.href)
            await abortable(assertLive(), signal)
            signal.throwIfAborted()
            if (status < 200 || status >= 300) throw new Error(`Documentation responded ${status}.`)
            const version = String(response.headers.etag ?? response.headers['last-modified'] ?? '').replace(/[\p{Cc}]/gu, '').slice(0, 512)
            return { body: page.body, byteLength: page.bytes, version }
        } finally {
            response.destroy()
        }
    }
}
