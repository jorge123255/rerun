import { decodeEntities, htmlTokens, tokenText, type HtmlAttributes, type HtmlToken } from './html-tokens.js'

const MAX_H1 = 3
const MAX_H1_CHARS = 120
const MAX_HREFLANG = 15
const MAX_LINKS_LISTED = 30
const MAX_JSON_NODES = 50_000

// Retain the original served/rendered distinction and fact labels; this parser only reads data.
export type PageSource = 'served' | 'rendered'
type PageFactsOptions = { url: string; source: PageSource; xRobotsTag?: string | null; redirectedTo?: string | null }

export function stripHtml(html: string): string {
    return tokenText(htmlTokens(html))
}

function tagsNamed(tokens: HtmlToken[], name: string): HtmlAttributes[] {
    return tokens.flatMap(token => token.kind === 'tag' && !token.closing && token.name === name ? [token.attributes] : [])
}

function elementText(tokens: HtmlToken[], name: string): string[] {
    const found: string[] = []
    let parts: string[] | null = null
    for (const token of tokens) {
        if (token.kind === 'tag' && token.name === name) {
            if (!token.closing && !parts) parts = []
            else if (token.closing && parts) { found.push(decodeEntities(parts.join('').replace(/\s+/g, ' ').trim())); parts = null }
        } else if (parts && token.kind !== 'raw') parts.push(token.kind === 'text' ? token.text : ' ')
    }
    return found
}

function relIncludes(attributes: HtmlAttributes, rel: string): boolean {
    return (attributes.rel ?? '').toLowerCase().split(/\s+/).includes(rel)
}

function sameSite(a: URL, b: URL): boolean {
    return a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '')
}

function resolveUrl(href: string, base: URL): URL | null {
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) return null
    try {
        const url = new URL(href, base)
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
    } catch { return null }
}

function shortUrl(url: URL, base: URL): string {
    return sameSite(url, base) ? `${url.pathname}${url.search}` : url.href
}

function jsonLdTypes(tokens: HtmlToken[]): string[] {
    const types = new Set<string>()
    let visited = 0
    for (const token of tokens) {
        if (token.kind !== 'raw' || token.name !== 'script' || token.attributes.type?.toLowerCase() !== 'application/ld+json') continue
        let data: unknown
        try { data = JSON.parse(token.text) } catch { continue }
        // JSON can be deeply nested despite fitting in the byte cap. Never recurse in JS.
        const pending: unknown[] = [data]
        while (pending.length) {
            if (++visited > MAX_JSON_NODES) throw new Error('JSON-LD exceeds the inspection limit')
            const node = pending.pop()
            if (Array.isArray(node)) {
                for (let index = node.length - 1; index >= 0; index--) pending.push(node[index])
            } else if (node && typeof node === 'object') {
                const record = node as Record<string, unknown>
                const type = record['@type']
                for (const value of Array.isArray(type) ? type : [type]) if (typeof value === 'string') types.add(value)
                if (record['@graph'] !== undefined) pending.push(record['@graph'])
            }
        }
    }
    return [...types]
}

function chromeLinks(tokens: HtmlToken[], base: URL): Set<string> {
    const paths = new Set<string>()
    const regions = new Map([['nav', 0], ['header', 0], ['footer', 0]])
    let depth = 0
    for (const token of tokens) {
        if (token.kind !== 'tag') continue
        const current = regions.get(token.name)
        if (current !== undefined) {
            if (!token.closing && !token.selfClosing) { regions.set(token.name, current + 1); depth++ }
            else if (token.closing && current > 0) { regions.set(token.name, current - 1); depth-- }
        } else if (depth && !token.closing && token.name === 'a') {
            const url = resolveUrl(token.attributes.href ?? '', base)
            if (url && sameSite(url, base)) paths.add(`${url.pathname}${url.search}`)
        }
    }
    return paths
}

function listed(items: string[], max: number): string {
    return items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max} more)` : items.join(', ')
}

export function pageFacts(html: string, { url, source, xRobotsTag, redirectedTo }: PageFactsOptions): string | null {
    let base: URL
    try { base = new URL(redirectedTo || url) } catch { return null }
    const tokens = htmlTokens(html)
    const meta = tagsNamed(tokens, 'meta')
    const metaContent = (name: string) => meta.find(m => (m.name ?? m.property ?? '').toLowerCase() === name)?.content || null
    const links = tagsNamed(tokens, 'link')
    const title = elementText(tokens, 'title')[0] || null
    const description = metaContent('description')
    const canonicalHref = links.find(l => relIncludes(l, 'canonical'))?.href
    const canonical = canonicalHref ? resolveUrl(canonicalHref, base)?.href ?? canonicalHref : null
    const robots = [
        ['meta robots', metaContent('robots')], ['meta googlebot', metaContent('googlebot')], ['X-Robots-Tag', xRobotsTag ?? null],
    ].flatMap(([label, value]) => value ? [`${label}: ${value}`] : [])
    const lang = tagsNamed(tokens, 'html')[0]?.lang || null
    const hreflang = links.filter(l => relIncludes(l, 'alternate') && l.hreflang && l.href).map(l => {
        const target = resolveUrl(l.href!, base)
        return `${l.hreflang} → ${target ? shortUrl(target, base) : l.href}`
    })
    const types = jsonLdTypes(tokens)
    const h1 = elementText(tokens, 'h1').map(inner => inner.slice(0, MAX_H1_CHARS)).filter(Boolean)
    const anchors = new Set<string>()
    const internalPaths = new Set<string>()
    let external = 0
    for (const { href } of tagsNamed(tokens, 'a')) {
        const target = resolveUrl(href ?? '', base)
        if (!target || anchors.has(target.href)) continue
        anchors.add(target.href)
        if (sameSite(target, base)) internalPaths.add(`${target.pathname}${target.search}`)
        else external++
    }
    const chrome = chromeLinks(tokens, base)
    const otherInternal = [...internalPaths].filter(path => !chrome.has(path))
    if (!title && !description && !canonical && !robots.length && !lang && !hreflang.length && !types.length && !h1.length && !anchors.size) return null
    const lines = [
        source === 'served' ? 'Page facts (HTML as served, before JavaScript):' : 'Page facts (HTML after JavaScript, read through Rerun):',
        `title: ${title || 'none'}`, `description: ${description ?? 'none'}`, `canonical: ${canonical ?? 'none'}`,
        `robots: ${robots.length ? robots.join('; ') : 'none set'}`, `lang: ${lang ?? 'none'}`,
        `hreflang: ${hreflang.length ? listed(hreflang, MAX_HREFLANG) : 'none'}`,
        `JSON-LD: ${types.length ? types.join(', ') : 'none'}`, `h1: ${h1.length ? listed(h1.map(h => `"${h}"`), MAX_H1) : 'none'}`,
    ]
    if (redirectedTo && redirectedTo !== url) lines.push(`redirected to: ${redirectedTo}`)
    lines.push(`links: ${internalPaths.size} internal, ${external} external`)
    lines.push(`nav/header/footer links: ${chrome.size ? listed([...chrome], MAX_LINKS_LISTED) : 'none'}`)
    lines.push(`other internal links: ${otherInternal.length ? listed(otherInternal, MAX_LINKS_LISTED) : 'none'}`)
    lines.push(`visible text: ${tokenText(tokens).length} chars`)
    return lines.join('\n')
}
