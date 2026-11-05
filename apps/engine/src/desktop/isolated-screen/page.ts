import { detectBotWall } from '../../tools/bot-wall.js'
import { IsolatedScreenRefusal } from './refusal.js'
import type { ScreenPage } from './types.js'

const TEXT_LIMIT = 50_000
const LINK_LIMIT = 300
const LINK_TEXT_LIMIT = 80
export const URL_MAX = 2048

const OPEN_PAGE = 'Open an http or https page.'

export function publicUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX) return null
    if (/[\u0000-\u001f\u007f]/.test(value)) return null
    try {
        const url = new URL(value)
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
        if (url.hostname.startsWith('.') || url.hostname.includes('..')) return null
        return value
    } catch {
        return null
    }
}

export function assertHttpUrl(value: string): string {
    if (publicUrl(value) === null) throw new IsolatedScreenRefusal(OPEN_PAGE, 'refused')
    return value
}

export function safePageLink(value: unknown): value is string {
    const safe = publicUrl(value)
    if (!safe) return false
    const host = new URL(safe).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    return !host.startsWith('::ffff:') && !(/^(?:localhost|.*\.localhost|127(?:\.\d+){3}|0\.0\.0\.0|::1|host\.docker\.internal|gateway\.docker\.internal)$/.test(host))
}

export function boundPage(raw: Record<string, unknown>, requestedUrl: string, includeLinks = true): ScreenPage {
    const html = typeof raw.html === 'string' ? raw.html : ''
    const fullText = typeof raw.text === 'string' ? raw.text : ''
    const wall = detectBotWall({ html, text: fullText })
    const links: ScreenPage['links'] = []
    const seen = new Set<string>()
    if (includeLinks && !wall && Array.isArray(raw.links)) {
        for (const link of raw.links) {
            if (links.length === LINK_LIMIT) break
            if (!link || typeof link !== 'object') continue
            const href = (link as { href?: unknown }).href
            const label = (link as { text?: unknown }).text
            if (!safePageLink(href) || seen.has(href)) continue
            seen.add(href)
            links.push({ href, text: typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, LINK_TEXT_LIMIT) : '' })
        }
    }
    const status = typeof raw.status === 'number' && Number.isInteger(raw.status) && raw.status >= 0 && raw.status <= 999 ? raw.status : 0
    return {
        status,
        finalUrl: publicUrl(raw.finalUrl) ?? requestedUrl,
        text: fullText.slice(0, TEXT_LIMIT),
        truncated: fullText.length > TEXT_LIMIT || raw.truncated === true,
        links,
        wall,
    }
}

export function formatScreenPage(page: ScreenPage, requestedUrl: string, includeLinks: boolean): string {
    const body = page.wall
        ? `Blocked by ${page.wall.provider} bot protection, so this page cannot be read from here. If the user can get past it by hand, call request_takeover with this URL; otherwise use another source.`
        : page.text
    const files = page.exports?.files ?? []
    const html = files.find(file => file.kind === 'rendered-html')
    const screenshot = files.find(file => file.kind === 'screenshot')
    const saved = html ? `\nSaved whole: ${html.path} (the rendered HTML: read or grep it for anything this text leaves out)` : ''
    const links = includeLinks ? `\n\nLinks:\n${page.wall ? 'unavailable (blocked)' : page.links.length ? page.links.map(link => link.text ? `- ${link.text} — ${link.href}` : `- ${link.href}`).join('\n') : 'none'}${page.linksTruncated ? '\n[link list truncated at the bounded limit]' : ''}` : ''
    const shot = screenshot ? `\n\n[screenshot saved to ${screenshot.path}]` : ''
    const note = page.exports && page.exports.status !== 'saved'
        ? `\n\n[exports ${page.exports.status}${page.exports.failure ? `: ${page.exports.failure}` : ''}; only the listed acknowledged files were saved. Inspect Files before retrying an uncertain attempt.]` : ''
    return `[${page.status}] ${requestedUrl}${saved}\n\n${body}${links}${shot}${note}`
}
