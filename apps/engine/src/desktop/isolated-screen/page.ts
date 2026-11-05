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

export function boundPage(raw: Record<string, unknown>, requestedUrl: string): ScreenPage {
    const html = typeof raw.html === 'string' ? raw.html : ''
    const fullText = typeof raw.text === 'string' ? raw.text : ''
    const wall = detectBotWall({ html, text: fullText })
    const links: ScreenPage['links'] = []
    if (!wall && Array.isArray(raw.links)) {
        for (const link of raw.links) {
            if (links.length === LINK_LIMIT) break
            if (!link || typeof link !== 'object') continue
            const href = (link as { href?: unknown }).href
            const label = (link as { text?: unknown }).text
            if (typeof href !== 'string' || publicUrl(href) === null) continue
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
