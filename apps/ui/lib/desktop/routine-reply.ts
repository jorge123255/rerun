import { ROUTINE_NO_UPDATE_MARKER, readRoutineReply } from '@rerun/contracts'

type Part = { type: string; text?: string }

/**
 * A routine reply as the conversation shows it: the "nothing to report" marker is never drawn. Null
 * when the reply carries no marker. `quiet` is a reply that said nothing else, which the
 * conversation draws as one muted line.
 */
export function desktopRoutineReplyOf<T extends { role: string; parts: readonly Part[] }>(message: T): { message: T; quiet: boolean } | null {
    if (message.role !== 'assistant') return null
    if (!message.parts.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.includes(ROUTINE_NO_UPDATE_MARKER))) return null
    const parts = message.parts.map(part => part.type === 'text' && typeof part.text === 'string' ? { ...part, text: readRoutineReply(part.text).text } : part)
    const quiet = parts.every(part => part.type !== 'text' || !part.text?.trim())
    return { message: { ...message, parts }, quiet }
}
