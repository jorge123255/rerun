/** Trusted Foreman chat identity — field names match I's DesktopForemanChatRef / Binding. */

export type DesktopForemanChatRef = {
    workspaceId: string
    chatId: string
}

export type DesktopForemanModelRef = {
    connectionId: string
    model: string
}

export type DesktopForemanBinding = DesktopForemanChatRef & {
    runId: string
    model: DesktopForemanModelRef
}

export type DesktopForemanLiveScope = DesktopForemanChatRef & {
    runId: string | null
    planRevisionId: string | null
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CHAT = /^fmc_[A-Za-z0-9-]{8,80}$/
const REVISION = /^fmr_[A-Za-z0-9-]{8,80}$/

export function isForemanId(value: unknown): value is string {
    return typeof value === 'string' && ID.test(value)
}

export function parseDesktopForemanChatRef(value: unknown): DesktopForemanChatRef | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort().join(',')
    if (keys !== 'chatId,workspaceId') return null
    if (!isForemanId(record.workspaceId) || typeof record.chatId !== 'string' || !CHAT.test(record.chatId)) return null
    return { workspaceId: record.workspaceId, chatId: record.chatId }
}

export function parseDesktopForemanBinding(value: unknown): DesktopForemanBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort().join(',')
    if (keys !== 'chatId,model,runId,workspaceId') return null
    if (!isForemanId(record.workspaceId) || typeof record.chatId !== 'string' || !CHAT.test(record.chatId)) return null
    if (!isForemanId(record.runId)) return null
    const model = record.model
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null
    const m = model as Record<string, unknown>
    if (typeof m.connectionId !== 'string' || !m.connectionId || typeof m.model !== 'string' || !m.model) return null
    return {
        workspaceId: record.workspaceId,
        chatId: record.chatId,
        runId: record.runId,
        model: { connectionId: m.connectionId, model: m.model },
    }
}

export function sameForemanChat(a: DesktopForemanChatRef | null | undefined, b: DesktopForemanChatRef | null | undefined): boolean {
    return !!a && !!b && a.workspaceId === b.workspaceId && a.chatId === b.chatId
}

export function foremanChatKey(chat: DesktopForemanChatRef): string {
    return `${chat.workspaceId}\u0000${chat.chatId}`
}

export function isForemanRevisionId(value: unknown): value is string {
    return typeof value === 'string' && REVISION.test(value)
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
