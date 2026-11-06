/** Trusted Foreman chat identity — field names match I's DesktopForemanChatRef / Binding. */

import {
    foremanBindingSchema, foremanChatRefSchema, foremanRevisionIdSchema, foremanRunIdSchema,
    type DesktopForemanChatRef, type DesktopForemanModelRef, type DesktopForemanBinding,
} from '@rerun/contracts'
export type { DesktopForemanChatRef, DesktopForemanModelRef, DesktopForemanBinding }

export type DesktopForemanLiveScope = DesktopForemanChatRef & {
    runId: string | null
    planRevisionId: string | null
}

export function isForemanId(value: unknown): value is string {
    return foremanRunIdSchema.safeParse(value).success
}

export function parseDesktopForemanChatRef(value: unknown): DesktopForemanChatRef | null {
    const result = foremanChatRefSchema.safeParse(value)
    return result.success ? result.data : null
}

export function parseDesktopForemanBinding(value: unknown): DesktopForemanBinding | null {
    const result = foremanBindingSchema.safeParse(value)
    return result.success ? result.data : null
}

export function sameForemanChat(a: DesktopForemanChatRef | null | undefined, b: DesktopForemanChatRef | null | undefined): boolean {
    return !!a && !!b && a.workspaceId === b.workspaceId && a.chatId === b.chatId
}

export function foremanChatKey(chat: DesktopForemanChatRef): string {
    return `${chat.workspaceId}\u0000${chat.chatId}`
}

export function isForemanRevisionId(value: unknown): value is string {
    return foremanRevisionIdSchema.safeParse(value).success
}

/**
 * Stale-reply gate: responses apply only when every supplied identity field still matches the live
 * scope. Historical views (live=null) never widen a live run or plan revision.
 */
export function acceptsForemanReply(live: DesktopForemanLiveScope, reply: Partial<DesktopForemanLiveScope>): boolean {
    if (reply.workspaceId !== undefined && reply.workspaceId !== live.workspaceId) return false
    if (reply.chatId !== undefined && reply.chatId !== live.chatId) return false
    if (reply.runId !== undefined && reply.runId !== live.runId) return false
    if (reply.planRevisionId !== undefined && reply.planRevisionId !== live.planRevisionId) return false
    return true
}

/** Conversation views with live=null cannot drive navigation, setup or discovery effects. */
export function isLiveForemanView(live: { runId: string } | null | undefined): live is { runId: string } {
    return !!live && typeof live.runId === 'string' && live.runId.length > 0
}
