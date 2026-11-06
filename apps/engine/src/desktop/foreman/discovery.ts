import { DESKTOP_DISCOVERY_SOURCES, type DesktopDiscoverySource, type DesktopForemanDiscoveryEvent, type DesktopForemanFinding } from '@rerun/contracts'

// Bounded public discovery over the already-authorized desktop web fetch. Only `site` is backed
// locally; desktop web_fetch has no search. Every other original collector is reported unavailable; nothing is inferred, scored or invented.

export type ForemanPageReader = (url: string, signal: AbortSignal) => Promise<{ ok: true; finalUrl: string; html: string } | { ok: false; reason: 'failed' | 'timeout' | 'blocked' }>

const MAX_HTML = 512 * 1024
const decode = (text: string) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()

function meta(html: string, name: string): string | null {
    const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i')
    const tag = html.match(pattern)?.[0]
    const content = tag?.match(/content=["']([^"']{1,600})["']/i)?.[1]
    return content ? decode(content) : null
}

export function identityFromPage(page: { finalUrl: string; html: string }, fetchedAt: string): DesktopForemanFinding | null {
    const html = page.html.slice(0, MAX_HTML)
    const domain = new URL(page.finalUrl).hostname.replace(/^www\./, '')
    const title = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]
    const name = meta(html, 'og:site_name') ?? (title ? decode(title).split(/\s[|–—-]\s/)[0] : null)
    if (!name) return null
    const oneLiner = meta(html, 'description') ?? meta(html, 'og:description')
    return { kind: 'identity', source: 'site', attribution: { url: page.finalUrl, fetchedAt }, name: name.slice(0, 200), oneLiner: oneLiner?.slice(0, 400) ?? null, logoUrl: null, domain }
}

export async function collectForemanDiscovery(input: { url: string; signal: AbortSignal; emit: (event: DesktopForemanDiscoveryEvent) => void; read: ForemanPageReader; now?: () => Date }) {
    const backed: DesktopDiscoverySource[] = ["site"]
    for (const source of DESKTOP_DISCOVERY_SOURCES) if (!backed.includes(source)) input.emit({ type: 'unavailable', source })
    const fetchedAt = () => (input.now?.() ?? new Date()).toISOString()

    input.emit({ type: 'pending', source: 'site' })
    const page = await input.read(input.url, input.signal).catch(() => ({ ok: false as const, reason: 'failed' as const }))
    if (!page.ok) input.emit({ type: 'dropped', source: 'site', reason: input.signal.aborted ? 'timeout' : page.reason })
    else {
        const identity = identityFromPage(page, fetchedAt())
        input.emit(identity ? { type: 'found', source: 'site', findings: [identity] } : { type: 'dropped', source: 'site', reason: 'empty' })
    }
}

// Adapter over the accepted desktop web_fetch transport. Root supplies the permission check the
// Foreman runs under; this never widens scope (public HTTP(S) only, no cookies, no rendering).
export function webFetchPageReader(execute: (input: unknown, context: { coworkerId: string; signal: AbortSignal; assertPermission: (coworkerId: string, tool: 'web_fetch') => Promise<void> }) => Promise<{ text: string; failed: boolean; finalUrl?: string; status?: number }>, context: { coworkerId: string; assertPermission: (coworkerId: string, tool: 'web_fetch') => Promise<void> }): ForemanPageReader {
    return async (url, signal) => {
        const result = await execute({ url, raw: true }, { ...context, signal })
        if (result.failed || !result.finalUrl) return { ok: false, reason: result.status === 403 ? 'blocked' : 'failed' }
        return { ok: true, finalUrl: result.finalUrl, html: result.text }
    }
}
