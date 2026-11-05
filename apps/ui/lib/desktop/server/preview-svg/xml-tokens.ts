/** A bounded, forward-only XML tokenizer for the SVG preview adapter.
 * It is not a DOM and it never decodes entities: any `&` anywhere is rejected, so the
 * document cannot smuggle an entity, an external entity, a character reference, or a
 * billion-laughs payload past validation. DTDs, processing instructions, and CDATA are
 * rejected up front, and every well-formedness rule is enforced while scanning once. */
import {
    DESKTOP_SVG_MAX_ATTRIBUTES,
    DESKTOP_SVG_MAX_ATTRIBUTE_VALUE_CHARS,
    DESKTOP_SVG_MAX_BYTES,
    DESKTOP_SVG_MAX_CHARS,
    DESKTOP_SVG_MAX_DEPTH,
    DESKTOP_SVG_MAX_ELEMENTS,
    DESKTOP_SVG_MAX_TEXT_CHARS,
    DESKTOP_SVG_MAX_TOTAL_ATTRIBUTES,
    DesktopSvgError,
} from './budgets'

export type XmlStart = { kind: 'start'; name: string; attributes: Record<string, string>; selfClosing: boolean }
export type XmlEnd = { kind: 'end'; name: string }
export type XmlText = { kind: 'text'; text: string }
export type XmlToken = XmlStart | XmlEnd | XmlText

// XML 1.0 valid characters are #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
const isLegalChar = (code: number) => code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
const space = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r'
const nameStart = (char: string) => /[A-Za-z_]/.test(char)
const nameChar = (char: string) => /[A-Za-z0-9_.:-]/.test(char)

function legalText(text: string): void {
    if (text.includes('&')) throw new DesktopSvgError('unsupported', 'entity reference')
    if (text.includes(']]>')) throw new DesktopSvgError('corrupt')
    for (let i = 0; i < text.length; i++) {
        if (!isLegalChar(text.charCodeAt(i))) throw new DesktopSvgError('corrupt')
    }
}

/** Scan the whole document and return its tokens. Throws DesktopSvgError on any
 * malformed construct, budget overrun, or forbidden XML feature. */
export function xmlTokens(bytes: Uint8Array): XmlToken[] {
    if (bytes.byteLength > DESKTOP_SVG_MAX_BYTES) throw new DesktopSvgError('dimensions')
    let source: string
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new DesktopSvgError('corrupt') }
    if (source.length > DESKTOP_SVG_MAX_CHARS) throw new DesktopSvgError('complex')

    const tokens: XmlToken[] = []
    const push = (token: XmlToken) => {
        // Each element contributes at most a start and an end token, and text is a token
        // per contiguous run, so a token budget of 4× the element budget bounds the scan.
        if (tokens.length >= DESKTOP_SVG_MAX_ELEMENTS * 4) throw new DesktopSvgError('complex')
        tokens.push(token)
    }

    const stack: string[] = []
    let elements = 0
    let attributes = 0
    let textChars = 0

    const flushText = (end: number, start: number) => {
        if (end <= start) return
        const text = source.slice(start, end)
        legalText(text)
        textChars += text.length
        if (textChars > DESKTOP_SVG_MAX_TEXT_CHARS) throw new DesktopSvgError('complex')
        if (text.trim().length > 0) push({ kind: 'text', text })
    }

    const endTagAt = (lt: number): number => {
        let i = lt + 2
        if (i >= source.length || !nameStart(source[i]!)) throw new DesktopSvgError('corrupt')
        const nameStartIndex = i
        while (i < source.length && nameChar(source[i]!)) i++
        const name = source.slice(nameStartIndex, i)
        while (i < source.length && space(source[i]!)) i++
        if (i >= source.length || source[i] !== '>') throw new DesktopSvgError('corrupt')
        if (stack.pop() !== name) throw new DesktopSvgError('corrupt')
        push({ kind: 'end', name })
        return i + 1
    }

    const startTagAt = (lt: number): number => {
        let i = lt + 1
        const nameStartIndex = i
        while (i < source.length && nameChar(source[i]!)) i++
        const name = source.slice(nameStartIndex, i)
        const attributesMap: Record<string, string> = Object.create(null)
        let attrCount = 0
        let selfClosing = false
        for (;;) {
            while (i < source.length && space(source[i]!)) i++
            if (i >= source.length) throw new DesktopSvgError('corrupt')
            if (source[i] === '>') { i++; break }
            if (source[i] === '/' && source[i + 1] === '>') { selfClosing = true; i += 2; break }
            if (source[i] === '/') throw new DesktopSvgError('corrupt')
            if (!nameStart(source[i]!)) throw new DesktopSvgError('corrupt')
            const attributeStart = i
            while (i < source.length && nameChar(source[i]!)) i++
            const attributeName = source.slice(attributeStart, i)
            if (attributeName in attributesMap) throw new DesktopSvgError('corrupt')
            while (i < source.length && space(source[i]!)) i++
            if (i >= source.length || source[i] !== '=') throw new DesktopSvgError('corrupt')
            i++
            while (i < source.length && space(source[i]!)) i++
            const quote = source[i]
            if (quote !== '"' && quote !== "'") throw new DesktopSvgError('corrupt')
            i++
            const valueStart = i
            while (i < source.length && source[i] !== quote) {
                const char = source[i]!
                if (char === '&') throw new DesktopSvgError('unsupported', 'entity reference')
                if (char === '<') throw new DesktopSvgError('corrupt')
                if (!isLegalChar(source.charCodeAt(i))) throw new DesktopSvgError('corrupt')
                i++
            }
            if (i >= source.length) throw new DesktopSvgError('corrupt')
            const value = source.slice(valueStart, i)
            i++
            if (value.length > DESKTOP_SVG_MAX_ATTRIBUTE_VALUE_CHARS) throw new DesktopSvgError('complex')
            if (++attrCount > DESKTOP_SVG_MAX_ATTRIBUTES) throw new DesktopSvgError('complex')
            if (++attributes > DESKTOP_SVG_MAX_TOTAL_ATTRIBUTES) throw new DesktopSvgError('complex')
            attributesMap[attributeName] = value
        }
        if (++elements > DESKTOP_SVG_MAX_ELEMENTS) throw new DesktopSvgError('complex')
        if (stack.length >= DESKTOP_SVG_MAX_DEPTH) throw new DesktopSvgError('complex')
        if (!selfClosing) stack.push(name)
        push({ kind: 'start', name, attributes: attributesMap, selfClosing })
        return i
    }

    // Only the first bytes of the document may be an XML declaration; any other
    // processing instruction is a document feature that is not previewed.
    const xmlDeclarationAt = (lt: number): number | null => {
        if (lt !== 0 || !/^<\?xml(?:\s|$)/i.test(source)) return null
        const end = source.indexOf('?>', lt + 2)
        if (end < 0) throw new DesktopSvgError('corrupt')
        // The declaration content starts after the `xml` target name.
        const declaration = source.slice(lt + 5, end).trim()
        const wellFormed = /^version\s*=\s*"1\.[01]"(?:\s+encoding\s*=\s*"(?:utf-8|utf8)")?(?:\s+standalone\s*=\s*"(?:yes|no)")?\s*$/i.test(declaration)
        if (!wellFormed) throw new DesktopSvgError('corrupt')
        return end + 2
    }

    const markupAt = (lt: number): number => {
        const next = source[lt + 1]
        if (next === '!') {
            if (source.startsWith('<!--', lt)) {
                const end = source.indexOf('-->', lt + 4)
                if (end < 0) throw new DesktopSvgError('corrupt')
                if (source.slice(lt + 4, end).includes('--')) throw new DesktopSvgError('corrupt')
                return end + 3
            }
            if (source.startsWith('<![CDATA[', lt)) throw new DesktopSvgError('unsupported', 'CDATA')
            throw new DesktopSvgError('unsupported', 'document type declaration')
        }
        if (next === '?') {
            const declarationEnd = xmlDeclarationAt(lt)
            if (declarationEnd !== null) return declarationEnd
            throw new DesktopSvgError('unsupported', 'processing instruction')
        }
        if (next === '/') return endTagAt(lt)
        if (next !== undefined && nameStart(next)) return startTagAt(lt)
        throw new DesktopSvgError('corrupt')
    }

    let cursor = 0
    while (cursor < source.length) {
        const lt = source.indexOf('<', cursor)
        if (lt < 0) {
            flushText(source.length, cursor)
            break
        }
        flushText(lt, cursor)
        cursor = markupAt(lt)
    }
    if (stack.length > 0) throw new DesktopSvgError('corrupt')
    return tokens
}
