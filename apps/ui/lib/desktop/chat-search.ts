import { z } from 'zod'

export const desktopConversationHitSchema = z.object({
    id: z.string(), agentId: z.string(), agentName: z.string(), title: z.string(),
    kind: z.enum(['general', 'thread']).optional(),
    firstMessage: z.string().nullable().optional(),
})
export const desktopChatSearchSchema = z.object({ hits: z.array(desktopConversationHitSchema), hasMore: z.boolean() })
export type DesktopConversationHit = z.infer<typeof desktopConversationHitSchema>

// Match canonically equivalent text without removing accents or changing the stored title.
export function conversationSearchKey(text: string): string {
    return text.normalize('NFC').toLowerCase().normalize('NFC')
}
