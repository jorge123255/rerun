import type { UIMessage } from 'ai'
import { DESKTOP_DOCUMENT_MAX_FILES, desktopDocumentReferenceSchema } from '@rerun/contracts'
import { z } from 'zod'

export const desktopSavedChatDecisionSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('answers'),
        items: z.array(z.strictObject({
            question: z.string().min(1).max(4000),
            answers: z.array(z.string().max(20_000)).max(101),
            fromOptions: z.boolean(),
            attachmentIds: z.array(z.string().uuid()).max(DESKTOP_DOCUMENT_MAX_FILES),
        })).min(1).max(32),
    }),
    z.strictObject({
        kind: z.literal('approvals'),
        items: z.array(z.strictObject({
            action: z.string().min(1).max(4000),
            detail: z.string().max(8000).optional(),
            decision: z.enum(['approved', 'declined']),
            note: z.string().max(20_000).optional(),
        })).min(1).max(20),
    }),
    z.strictObject({ kind: z.literal('question-dismissed') }),
])

export type DesktopSavedChatDecision = z.infer<typeof desktopSavedChatDecisionSchema>

export const desktopSavedChatReceiptSchema = z.strictObject({
    sourceMessageId: z.string().min(1).max(263),
    sourceToolCallId: z.string().min(1).max(256),
    decision: desktopSavedChatDecisionSchema,
})
export type DesktopSavedChatReceipt = z.infer<typeof desktopSavedChatReceiptSchema>

export function desktopSavedChatReceiptOf(message: UIMessage, agentId: string, sessionId: string | null, tabUid?: string) {
    if (message.role !== 'user' || !message.id.startsWith('engine-') || !sessionId ||
        !message.metadata || typeof message.metadata !== 'object' || !('savedDecision' in message.metadata)) return null
    const receipt = desktopSavedChatReceiptSchema.safeParse(message.metadata.savedDecision)
    const documents = desktopDocumentReferenceSchema.array().safeParse('documents' in message.metadata ? message.metadata.documents : [])
    if (!receipt.success || !documents.success) return null
    const decision = receipt.data.decision
    const ids = decision.kind === 'answers' ? decision.items.flatMap(item => item.attachmentIds) : []
    if (new Set(ids).size !== ids.length || ids.length !== documents.data.length ||
        !documents.data.every(file => ids.includes(file.attachmentId) && file.scope.agentId === agentId && file.scope.sessionId === sessionId
            && (!tabUid || file.scope.tabUid === tabUid))) return null
    return { ...receipt.data, documents: documents.data }
}
