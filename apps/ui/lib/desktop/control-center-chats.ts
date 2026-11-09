import { z } from 'zod'
import { MAX_REMEMBERED_TABS } from '@/lib/chat/session-tabs'
import { desktopConversationHitSchema } from './chat-search'

export const DESKTOP_RECENT_CHAT_LIMIT = 8
const id = z.string().min(1).max(200)

export const desktopOpenChatSchema = z.object({
    agentId: id,
    tabUid: z.string().min(1).max(128),
    sessionId: id.nullable(),
    title: z.string(),
    kind: z.enum(['general', 'thread']).optional(),
    firstMessage: z.string().nullable().optional(),
})
export type DesktopOpenChat = z.infer<typeof desktopOpenChatSchema>

export const desktopControlCenterChatsSchema = z.object({
    agentId: id,
    openChats: z.array(desktopOpenChatSchema).max(MAX_REMEMBERED_TABS + 1),
    recentChats: z.array(desktopConversationHitSchema).max(DESKTOP_RECENT_CHAT_LIMIT),
    recentStatus: z.enum(['ok', 'unavailable']),
    hasMore: z.boolean(),
})
export type DesktopControlCenterChats = z.infer<typeof desktopControlCenterChatsSchema>
