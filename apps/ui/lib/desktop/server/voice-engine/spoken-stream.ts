import { desktopSpeechText } from '@/lib/desktop/speech'

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const RULE = /^\s{0,3}(?:(?:[-*_]\s*){3,}|=+|-+)\s*$/
// A sentence ends at . ! ? or … followed by space, with any closing quotes or brackets.
const SENTENCE_END = /[.!?…]["'”’)\]]*\s+/g
const LONG_LINE = 240

/** Inline marks are spoken right only once they close: never cut a line inside one. */
function balanced(text: string): boolean {
    const count = (pattern: RegExp) => (text.match(pattern) ?? []).length
    return count(/`/g) % 2 === 0 && count(/\*\*/g) % 2 === 0 && count(/__/g) % 2 === 0 && count(/~~/g) % 2 === 0
        && count(/\[/g) === count(/]/g) && count(/\(/g) === count(/\)/g) && count(/</g) === count(/>/g)
}

/**
 * A reply's markdown, spoken as it streams, by the same rules as reading a saved reply aloud: code
 * and tables are left out, a link is read by its text, a bare address as "link". Whole lines are
 * spoken as they complete; within a long line, finished sentences go first.
 */
export function createSpokenStream() {
    let raw = '', position = 0, atLineStart = true, saidCode = false, inTable = false
    let fence: { mark: string; length: number } | null = null
    let heldHeader: string | null = null

    const spoken = (text: string) => desktopSpeechText(text).replace(/\s+/g, ' ').trim()

    function line(text: string): string[] {
        if (fence) {
            const close = FENCE.exec(text)
            if (close && close[1][0] === fence.mark && close[1].length >= fence.length && !text.slice(close[0].length).trim()) fence = null
            return []
        }
        const opening = FENCE.exec(text)
        if (opening) {
            fence = { mark: opening[1][0], length: opening[1].length }
            if (saidCode) return []
            saidCode = true
            return ['Code block omitted.']
        }
        if (inTable) {
            if (text.trim() && text.includes('|')) return []
            inTable = false
        }
        if (heldHeader !== null) {
            const header = heldHeader
            heldHeader = null
            if (TABLE_RULE.test(text)) { inTable = true; return ['Table omitted.'] }
            return [spoken(header), ...line(text)]
        }
        if (text.includes('|')) { heldHeader = text; return [] }
        if (RULE.test(text)) return []
        return [spoken(text)]
    }

    function drain(final: boolean): string {
        const out: string[] = []
        for (;;) {
            const newline = raw.indexOf('\n', position)
            if (newline === -1) {
                const rest = raw.slice(position)
                if (final) {
                    if (rest) out.push(...line(rest))
                    if (heldHeader !== null) { out.push(spoken(heldHeader)); heldHeader = null }
                    position = raw.length
                } else if (!fence && heldHeader === null && !(atLineStart && (FENCE.test(rest) || rest.includes('|') || /^\s*`{1,2}$|^\s*~{1,2}$/.test(rest)))) {
                    let cut = 0
                    for (const match of rest.matchAll(SENTENCE_END)) {
                        const end = match.index + match[0].length
                        if (balanced(rest.slice(0, end))) cut = end
                    }
                    if (!cut && rest.length > LONG_LINE) {
                        const space = rest.lastIndexOf(' ')
                        if (space > LONG_LINE / 2 && balanced(rest.slice(0, space))) cut = space + 1
                    }
                    if (cut) {
                        out.push(spoken(rest.slice(0, cut)))
                        position += cut
                        atLineStart = false
                    }
                }
                break
            }
            const text = raw.slice(position, newline)
            position = newline + 1
            // The rest of a line already partly spoken is plain text, not the start of a block.
            out.push(...(atLineStart ? line(text) : [spoken(text)]))
            atLineStart = true
        }
        return out.filter(Boolean).map(piece => piece + ' ').join('')
    }

    return {
        /** More of the reply; returns the speech that is now ready and was not given before. */
        append(delta: string): string {
            raw += delta
            return drain(false)
        },
        end(): string { return drain(true) },
    }
}
