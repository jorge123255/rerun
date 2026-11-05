import { z } from 'zod'

const approvalId = z.string().regex(/^[a-f0-9]{64}$/)
const decision = z.discriminatedUnion('decision', [
    z.object({ decision: z.literal('approved') }).strict(),
    z.object({ decision: z.literal('declined'), note: z.string().trim().max(20_000).optional() }).strict(),
])
const decisions = z.array(decision).min(1).max(20)
    .refine(items => items.reduce((length, item) => length + (item.decision === 'declined' ? item.note?.length ?? 0 : 0), 0) <= 20_000, 'Keep the reasons under 20,000 characters.')
export const desktopApprovalPayloadSchema = z.object({ decisions }).strict()
export const desktopApprovalAnswerSchema = desktopApprovalPayloadSchema.extend({ approvalId, requestId: z.string().uuid() }).strict()
export type DesktopApprovalAnswer = z.infer<typeof desktopApprovalAnswerSchema>
export type DesktopApprovalPayload = z.infer<typeof desktopApprovalPayloadSchema>

const approvalItem = z.object({ action: z.string().min(1).max(4_000), detail: z.string().max(8_000).optional() })
export const desktopPendingApprovalSchema = z.object({
    id: approvalId,
    messageId: z.string().min(1),
    toolCallId: z.string().min(1),
    approvals: z.array(approvalItem).min(1).max(20),
    // The source request message's own timestamp: the pending request's age and order.
    requestedAt: z.string().optional(),
    attempt: desktopApprovalPayloadSchema.extend({ requestId: z.string().uuid() }).optional(),
})
export const desktopApprovalViewSchema = z.object({ approval: desktopPendingApprovalSchema.nullable() })
export type DesktopPendingApproval = z.infer<typeof desktopPendingApprovalSchema>
export type DesktopApprovalView = z.infer<typeof desktopApprovalViewSchema>
