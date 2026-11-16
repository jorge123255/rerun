import type { DesktopForemanClientState } from '../foreman-client/runtime-client'

type SavedMessage = DesktopForemanClientState['messages'][number]
export type DesktopForemanRetry = { text: string; coworkerMentions?: NonNullable<SavedMessage['metadata']>['coworkerMentions'] }

const textOf = (part: unknown) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : null

/**
 * What Retry on the Chief of Staff's error card sends again (upstream #254): the last message the
 * user typed, with its coworker mentions. Null when there is nothing safe to resend: no user message,
 * one that carried files (their bytes are not kept for a second send), or a saved decision.
 */
export function desktopForemanRetryOf(messages: DesktopForemanClientState['messages']): DesktopForemanRetry | null {
    const last = messages.findLast(message => message.role === 'user')
    if (!last || last.metadata?.documents?.length || last.metadata?.savedDecision !== undefined || last.metadata?.compactionReceipt !== undefined) return null
    const texts = last.parts.map(textOf)
    if (texts.some(text => text === null)) return null
    const text = texts.join('').trim()
    if (!text) return null
    const coworkerMentions = last.metadata?.coworkerMentions
    return coworkerMentions?.length ? { text, coworkerMentions } : { text }
}
