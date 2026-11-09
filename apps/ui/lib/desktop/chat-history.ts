import { sessionSourceSchema } from '@rerun/contracts'
import { z } from 'zod'
import { messageDayLabel } from '@/lib/time'

export const desktopChatFilterSchema = z.enum(['all', 'chats', 'automations', 'needs'])
export type DesktopChatFilter = z.infer<typeof desktopChatFilterSchema>

export const desktopChatHistoryConversationSchema = z.object({
    id: z.string(),
    agentId: z.string(),
    engineSessionId: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    source: sessionSourceSchema.nullable(),
    needsYou: z.boolean(),
    pendingQuestion: z.string().nullable(),
    kind: z.enum(['general', 'thread']).optional(),
    firstMessage: z.string().nullable().optional(),
})
export type DesktopChatHistoryConversation = z.infer<typeof desktopChatHistoryConversationSchema>

export const desktopChatHistorySchema = z.object({
    conversations: z.array(desktopChatHistoryConversationSchema),
    enrichment: z.enum(['ok', 'unavailable']),
    questions: z.enum(['ok', 'unavailable']),
})
export type DesktopChatHistory = z.infer<typeof desktopChatHistorySchema>

export const DESKTOP_CHAT_FILTERS = [
    { value: 'all', label: 'All' },
    { value: 'chats', label: 'Threads' },
    { value: 'automations', label: 'Automations' },
    { value: 'needs', label: 'Needs you' },
] as const satisfies readonly { value: DesktopChatFilter; label: string }[]

export function isAutomatedChat(conversation: Pick<DesktopChatHistoryConversation, 'source'>): boolean {
    return conversation.source === 'schedule' || conversation.source === 'trigger'
}

export function isOrdinaryChat(conversation: Pick<DesktopChatHistoryConversation, 'source'>): boolean {
    return conversation.source !== null && !isAutomatedChat(conversation)
}

function updatedTime(conversation: DesktopChatHistoryConversation): number {
    const parsed = Date.parse(conversation.updatedAt)
    return Number.isFinite(parsed) ? parsed : 0
}

export function sortDesktopChats(conversations: readonly DesktopChatHistoryConversation[]): DesktopChatHistoryConversation[] {
    return [...conversations].sort((a, b) => updatedTime(b) - updatedTime(a) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}

export function filterDesktopChats(conversations: readonly DesktopChatHistoryConversation[], filter: DesktopChatFilter, query: string): DesktopChatHistoryConversation[] {
    const needle = query.trim().toLocaleLowerCase()
    const seen = new Set<string>()
    return sortDesktopChats(conversations.filter(conversation => {
        if (seen.has(conversation.id) || conversation.kind === 'general') return false
        seen.add(conversation.id)
        if (filter === 'automations' && !isAutomatedChat(conversation)) return false
        if (filter === 'chats' && !isOrdinaryChat(conversation)) return false
        if (filter === 'needs' && !conversation.needsYou) return false
        const haystack = `${conversation.title}\n${conversation.firstMessage ?? ''}`.toLocaleLowerCase()
        return !needle || haystack.includes(needle)
    }))
}

export function groupDesktopChats(conversations: readonly DesktopChatHistoryConversation[], now = new Date()) {
    const groups: { day: string; entries: DesktopChatHistoryConversation[] }[] = []
    for (const conversation of sortDesktopChats(conversations)) {
        const day = Number.isFinite(Date.parse(conversation.updatedAt)) ? messageDayLabel(conversation.updatedAt, now) : 'Date unavailable'
        const last = groups.at(-1)
        if (last?.day === day) last.entries.push(conversation)
        else groups.push({ day, entries: [conversation] })
    }
    return groups
}

export function countChatsNeedingYou(conversations: readonly DesktopChatHistoryConversation[]): number {
    return conversations.filter(conversation => conversation.needsYou).length
}
