import { z } from 'zod'

// A read-only projection of the existing, receipt-aware question and approval cards.
// Opening an item never accepts, dismisses, or executes its request.
export const desktopAttentionItemSchema = z.object({
    id: z.string().min(1),
    kind: z.enum(['question', 'approval', 'takeover', 'service', 'secret']),
    agentId: z.string().min(1),
    agentName: z.string(),
    agentEnabled: z.boolean(),
    sessionId: z.string().min(1),
    title: z.string(),
    summary: z.string().max(280),
    // The source request message's own timestamp when it is known; the chat's latest activity is
    // the fallback, never the pending request's age on its own.
    requestedAt: z.string().optional(),
    updatedAt: z.string(),
})
export const desktopAttentionSchema = z.object({
    items: z.array(desktopAttentionItemSchema),
    // A partial read cannot be presented as an empty or fully resolved workspace.
    unavailableAgentIds: z.array(z.string()),
    checkedAt: z.string(),
})
export type DesktopAttentionItem = z.infer<typeof desktopAttentionItemSchema>
export type DesktopAttention = z.infer<typeof desktopAttentionSchema>
export const DESKTOP_ATTENTION_URL = '/api/desktop/attention'
