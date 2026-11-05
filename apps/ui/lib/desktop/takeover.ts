import { z } from 'zod'

const takeoverId = z.string().regex(/^[a-f0-9]{64}$/)
const requestId = z.string().uuid()
const terminalAction = z.discriminatedUnion('action', [
    z.object({ action: z.literal('done'), takeoverId, requestId }).strict(),
    z.object({ action: z.literal('skip'), takeoverId, requestId }).strict(),
])
export const desktopTakeoverActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('release'), takeoverId, requestId, lease: z.string().min(1).max(500) }).strict(),
    z.object({ action: z.literal('open'), takeoverId, requestId }).strict(),
    z.object({ action: z.literal('done'), takeoverId, requestId }).strict(),
    z.object({ action: z.literal('skip'), takeoverId, requestId }).strict(),
])
export type DesktopTakeoverAction = z.infer<typeof desktopTakeoverActionSchema>
export type DesktopTakeoverTerminal = z.infer<typeof terminalAction>

const pendingTakeover = z.object({
    id: takeoverId,
    messageId: z.string().min(1),
    toolCallId: z.string().min(1),
    url: z.string(),
    reason: z.string(),
    opened: z.boolean(),
    requestedAt: z.string().optional(),
    attempt: terminalAction.optional(),
})
export const desktopTakeoverViewSchema = z.object({ takeover: pendingTakeover.nullable() })
export type DesktopPendingTakeover = z.infer<typeof pendingTakeover>
export type DesktopTakeoverView = z.infer<typeof desktopTakeoverViewSchema>
