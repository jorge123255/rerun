import { Resolver } from 'node:dns/promises'
import { DESKTOP_COMPANY_DISCOVERY_LIMITS } from '@rerun/contracts'
import { abortable, readPublicPage } from '../web-fetch/transport.ts'
import { publicDestination, publicUrl } from '../web-fetch/public-url.ts'
import { classifyPublicFailure, type DnsLookup, type PublicPageReader } from './ports.ts'

// Production readers. Every hop uses the accepted public-fetch confinement: no cookies, no
// credential jar, no browser profile, and a second DNS check before the connection.

function childSignal(parent: AbortSignal): { signal: AbortSignal; timedOut: () => boolean } {
    const timeout = AbortSignal.timeout(DESKTOP_COMPANY_DISCOVERY_LIMITS.pageDeadlineMs)
    return { signal: AbortSignal.any([parent, timeout]), timedOut: () => timeout.aborted && !parent.aborted }
}

export function confinedCompanyReader(assertPermission: () => Promise<void>): PublicPageReader {
    return async (url, parent, accept) => {
        const { signal, timedOut } = childSignal(parent)
        try {
            publicUrl(url)
            const page = await readPublicPage(url, signal, assertPermission)
            if (accept === 'json' && !page.contentType.toLowerCase().includes('json')) return { ok: false, reason: 'malformed' }
            if (page.status >= 400) return { ok: false, reason: 'failed' }
            return { ok: true, url: page.url, status: page.status, contentType: page.contentType, body: page.body, bytes: page.bytes }
        } catch (error) {
            if (timedOut()) return { ok: false, reason: 'timeout' }
            const reason = classifyPublicFailure(error, parent)
            return { ok: false, reason: reason === 'timeout' && parent.aborted ? 'cancelled' : reason }
        }
    }
}

async function records(resolver: Resolver, host: string, signal: AbortSignal): Promise<string[]> {
    try {
        const rows = await resolver.resolveTxt(host)
        signal.throwIfAborted()
        return rows.map(chunks => chunks.join('')).slice(0, 40)
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL') return []
        throw error
    }
}

export function confinedCompanyDns(assertPermission: () => Promise<void>): DnsLookup {
    return async (domain, parent) => {
        const { signal, timedOut } = childSignal(parent)
        const resolver = new Resolver()
        const cancel = () => resolver.cancel()
        signal.addEventListener('abort', cancel, { once: true })
        try {
            await abortable(assertPermission(), signal)
            const url = publicUrl(`https://${domain}/`)
            await abortable(publicDestination(url), signal)
            signal.throwIfAborted()
            await abortable(assertPermission(), signal)
            const [mx, txt, dmarc] = await Promise.all([
                resolver.resolveMx(domain).then(rows => rows.sort((a, b) => a.priority - b.priority).map(row => row.exchange).slice(0, 20)).catch(error => {
                    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
                    if (code === 'ENOTFOUND' || code === 'ENODATA') return [] as string[]
                    throw error
                }),
                records(resolver, domain, signal),
                records(resolver, `_dmarc.${domain}`, signal),
            ])
            signal.throwIfAborted()
            await abortable(assertPermission(), signal)
            return { ok: true, records: { mx, txt, dmarc } }
        } catch (error) {
            if (timedOut()) return { ok: false, reason: 'timeout' }
            const reason = classifyPublicFailure(error, parent)
            if (reason === 'private') return { ok: false, reason: 'private' }
            if (parent.aborted) return { ok: false, reason: 'cancelled' }
            return { ok: false, reason: reason === 'malformed' ? 'failed' : reason === 'oversized' ? 'failed' : reason }
        } finally { signal.removeEventListener('abort', cancel); resolver.cancel() }
    }
}
