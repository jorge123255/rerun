// A bounded, forward-only HTML reader, not a browser DOM. Malformed tags and raw
// script/style bodies are visited once, without regex searches over an unbounded suffix.
export const MAX_HTML_CHARS = 1_000_000
export const MAX_HTML_TOKENS = 20_000
const MAX_ATTRIBUTES = 128

export type HtmlAttributes = Record<string, string>
export type HtmlToken =
    | { kind: 'text'; text: string }
    | { kind: 'gap' }
    | { kind: 'tag'; name: string; closing: boolean; selfClosing: boolean; attributes: HtmlAttributes }
    | { kind: 'raw'; name: 'script' | 'style'; text: string; attributes: HtmlAttributes }
type Tag = Extract<HtmlToken, { kind: 'tag' }>

const space = (char: string) => /\s/.test(char)
const nameChar = (char: string) => /[a-zA-Z0-9:_-]/.test(char)
const letter = (char: string) => /[a-zA-Z]/.test(char)

function attributes(source: string): HtmlAttributes {
    const result: HtmlAttributes = Object.create(null)
    let cursor = 0
    let count = 0
    while (cursor < source.length) {
        if (!nameChar(source[cursor]!)) { cursor++; continue }
        const start = cursor
        while (cursor < source.length && nameChar(source[cursor]!)) cursor++
        const name = source.slice(start, cursor).toLowerCase()
        if (++count > MAX_ATTRIBUTES) throw new Error('HTML tag has too many attributes to inspect safely')
        while (cursor < source.length && space(source[cursor]!)) cursor++
        if (source[cursor] !== '=') continue
        cursor++
        while (cursor < source.length && space(source[cursor]!)) cursor++
        const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor++] : null
        const valueStart = cursor
        if (quote) {
            while (cursor < source.length && source[cursor] !== quote) cursor++
        } else {
            while (cursor < source.length && !space(source[cursor]!) && source[cursor] !== '>' && source[cursor] !== '"' && source[cursor] !== "'") cursor++
        }
        result[name] = decodeEntities(source.slice(valueStart, cursor)).trim()
        if (quote && source[cursor] === quote) cursor++
    }
    return result
}

function tagAt(html: string, start: number): { next: number; tag?: Tag } {
    let cursor = start + 1
    const closing = html[cursor] === '/'
    if (closing) cursor++
    if (cursor >= html.length || !letter(html[cursor]!)) return { next: cursor }
    const nameStart = cursor
    while (cursor < html.length && nameChar(html[cursor]!)) cursor++
    const name = html.slice(nameStart, cursor).toLowerCase()
    const attributesStart = cursor
    let quote: string | null = null
    for (; cursor < html.length; cursor++) {
        const char = html[cursor]!
        if (quote) { if (char === quote) quote = null; continue }
        if (char === '"' || char === "'") { quote = char; continue }
        if (char === '<') return { next: cursor }
        if (char === '>') return { next: cursor + 1, tag: {
            kind: 'tag', name, closing, selfClosing: html[cursor - 1] === '/',
            attributes: closing ? Object.create(null) : attributes(html.slice(attributesStart, cursor)),
        } }
    }
    return { next: html.length }
}

export function htmlTokens(html: string): HtmlToken[] {
    if (html.length > MAX_HTML_CHARS) throw new Error('HTML exceeds the inspection limit')
    const tokens: HtmlToken[] = []
    const push = (token: HtmlToken) => {
        if (tokens.length >= MAX_HTML_TOKENS) throw new Error('HTML has too many elements to inspect safely')
        tokens.push(token)
    }
    let cursor = 0
    let textStart = 0
    let lower: string | undefined
    const flushText = (end: number) => { if (end > textStart) push({ kind: 'text', text: html.slice(textStart, end) }) }
    while (cursor < html.length) {
        const start = html.indexOf('<', cursor)
        if (start < 0) break
        if (html.startsWith('<!--', start)) {
            flushText(start)
            const end = html.indexOf('-->', start + 4)
            cursor = end < 0 ? html.length : end + 3
            push({ kind: 'gap' })
            textStart = cursor
            continue
        }
        if (html[start + 1] === '!' || html[start + 1] === '?') {
            flushText(start)
            const end = html.indexOf('>', start + 2)
            cursor = end < 0 ? html.length : end + 1
            push({ kind: 'gap' })
            textStart = cursor
            continue
        }
        const parsed = tagAt(html, start)
        cursor = parsed.next
        if (!parsed.tag) continue
        flushText(start)
        const tag = parsed.tag
        if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
            // ASCII folding preserves UTF-16 offsets (Unicode lowercasing can change length).
            lower ??= html.replace(/[A-Z]/g, char => char.toLowerCase())
            const needle = `</${tag.name}`
            let searchFrom = cursor
            let end = html.length
            let next = html.length
            while (searchFrom < html.length) {
                const candidate = lower.indexOf(needle, searchFrom)
                if (candidate < 0) break
                const boundary = candidate + needle.length
                if (boundary < html.length && nameChar(html[boundary]!)) { searchFrom = boundary; continue }
                const close = tagAt(html, candidate)
                if (close.tag?.closing && close.tag.name === tag.name) { end = candidate; next = close.next; break }
                searchFrom = close.next
            }
            push({ kind: 'raw', name: tag.name, attributes: tag.attributes, text: html.slice(cursor, end) })
            cursor = next
        } else push(tag)
        textStart = cursor
    }
    flushText(html.length)
    return tokens
}

export function tokenText(tokens: HtmlToken[]): string {
    const text: string[] = []
    for (const token of tokens) {
        if (token.kind === 'text') text.push(token.text)
        else if (token.kind !== 'raw') text.push(' ')
    }
    return text.join('').replace(/\s+/g, ' ').trim()
}

// Entity expressions never scan across the start of another entity. Each fixed pass is linear.
export function decodeEntities(text: string): string {
    const codePointOrText = (entity: string, code: number) => Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    return text
        .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => codePointOrText(entity, parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (entity, dec: string) => codePointOrText(entity, Number(dec)))
        .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}
