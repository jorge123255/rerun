import type { DesktopForemanChatRef, DesktopForemanConversationView } from '@rerun/contracts'

/**
 * Whether a saved Foreman answer may be regenerated.
 *
 * This is the whole gate: the Mac Foreman runs one engine conversation per chat, has no alternate
 * transcript beside it, and the engine's only regeneration is a fork into a new session. Until a
 * durable replacement or a reachable alternate is proven, every call here refuses, so the original
 * answer is never replaced or lost by a UI affordance that cannot keep it.
 */
export type ForemanRegenerateRefusal =
    | 'no-durable-alternate'
    | 'active-turn'
    | 'active-build'
    | 'pending-question'
    | 'pending-approval'
    | 'stale-reply'
    | 'foreign-chat'
    | 'not-engine-reply'
    | 'no-preceding-turn'

export type ForemanRegenerateInput = {
    /** The chat the Foreman is showing. */
    chat: DesktopForemanChatRef
    /** The trusted conversation view of that chat; null before it is read. */
    view: DesktopForemanConversationView | null
    /** The saved reply whose row was clicked, as it was rendered. */
    message: { id: string; role: string; text: string; chat?: DesktopForemanChatRef | null } | null
    /** True while a question the user has not answered holds the turn. */
    pendingQuestion: boolean
    /** Revision the clicked row was drawn from, and the one on screen now. */
    renderedRevision?: string | null
    currentRevision?: string | null
    /** Exact saved text of the user turn this reply answers. */
    previousUserText?: string | null
    /** True only when a durable replacement, or an alternate the reader can return to, is proven. */
    durableAlternate: boolean
}

export type ForemanRegenerateCheck =
    | { ok: true; messageId: string }
    | { ok: false; reason: ForemanRegenerateRefusal }

const refuse = (reason: ForemanRegenerateRefusal): ForemanRegenerateCheck => ({ ok: false, reason })
const ENGINE_REPLY = /^engine-[A-Za-z0-9_-]{1,128}$/

export function checkForemanRegenerate(input: ForemanRegenerateInput): ForemanRegenerateCheck {
    if (!input.durableAlternate) return refuse('no-durable-alternate')
    const { view, message, chat } = input
    if (!view || view.chat.workspaceId !== chat.workspaceId || view.chat.chatId !== chat.chatId) return refuse('foreign-chat')
    if (!message || message.role !== 'assistant' || !ENGINE_REPLY.test(message.id) || !message.text.trim()) return refuse('not-engine-reply')
    if (message.chat && (message.chat.workspaceId !== chat.workspaceId || message.chat.chatId !== chat.chatId)) return refuse('foreign-chat')
    if (view.live) return refuse('active-turn')
    if (view.build && (view.build.state === 'reserved' || view.build.state === 'running')) return refuse('active-build')
    if (input.pendingQuestion) return refuse('pending-question')
    if (view.blocked || view.decisions.some(decision => decision.state === 'pending')) return refuse('pending-approval')
    if (input.renderedRevision && input.currentRevision && input.renderedRevision !== input.currentRevision) return refuse('stale-reply')
    if (!input.previousUserText?.trim()) return refuse('no-preceding-turn')
    return { ok: true, messageId: message.id }
}

/** What the row says when it cannot regenerate, so the answer is kept and the reason is honest. */
export const FOREMAN_REGENERATE_REFUSAL: Record<ForemanRegenerateRefusal, string> = {
    'no-durable-alternate': 'Regenerating is unavailable until a new answer can be kept beside this one.',
    'active-turn': 'Wait for this reply to finish before regenerating it.',
    'active-build': 'A build is running. Regenerate once it has finished.',
    'pending-question': 'Answer the question above first.',
    'pending-approval': 'A plan is waiting for you. Regenerate after deciding.',
    'stale-reply': 'This transcript moved. Reopen the reply before regenerating it.',
    'foreign-chat': 'That reply belongs to another conversation.',
    'not-engine-reply': 'Only a saved engine reply can be regenerated.',
    'no-preceding-turn': 'This reply has no saved question to ask again.',
}
