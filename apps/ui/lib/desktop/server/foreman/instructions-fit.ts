import { DESKTOP_FOREMAN_INSTRUCTIONS_LIMIT } from '@rerun/contracts'

/** A part that can be said at more than one length: it is given the room that is left and answers with a text that fits it, or nothing. */
export type FlexibleInstruction = (budget: number) => string | null
const JOIN = '\n\n'

/**
 * Joins what the Chief of Staff is told this turn so that it is never longer than the engine
 * accepts. A turn over the limit is refused whole and the conversation stops ("The Foreman message
 * was not confirmed"), so the fixed parts are placed first and each flexible part is given what is
 * left. If the fixed parts alone are too long, the last ones are dropped, never cut mid-sentence.
 */
export function fitForemanInstructions(parts: readonly (string | FlexibleInstruction | null | undefined | false)[], limit = DESKTOP_FOREMAN_INSTRUCTIONS_LIMIT): string {
    const kept = parts.filter((part): part is string | FlexibleInstruction => typeof part === 'function' || (typeof part === 'string' && part.length > 0))
    const fixed = kept.filter((part): part is string => typeof part === 'string')
    // The first fixed part is the Chief of Staff's own role and always stays; later ones go first.
    while (fixed.length > 1 && fixed.join(JOIN).length > limit) fixed.pop()
    let room = limit - fixed.join(JOIN).length
    const flexible = new Map<FlexibleInstruction, string>()
    for (const part of kept) {
        if (typeof part !== 'function') continue
        const text = room > JOIN.length ? part(room - JOIN.length) : null
        if (!text || text.length > room - JOIN.length) continue
        flexible.set(part, text)
        room -= text.length + JOIN.length
    }
    const order = kept.flatMap(part => typeof part === 'function' ? (flexible.has(part) ? [flexible.get(part)!] : []) : fixed.includes(part) ? [part] : [])
    return order.join(JOIN).slice(0, limit)
}
