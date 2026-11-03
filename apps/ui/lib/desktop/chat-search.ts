import { z } from 'zod'

export const desktopConversationHitSchema = z.object({ id: z.string(), agentId: z.string(), agentName: z.string(), title: z.string() })
export const desktopChatSearchSchema = z.object({ hits: z.array(desktopConversationHitSchema), hasMore: z.boolean() })
export type DesktopConversationHit = z.infer<typeof desktopConversationHitSchema>
