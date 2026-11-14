import { z } from 'zod'
import { desktopDocumentSendSelectionSchema } from '@rerun/contracts'

const questionId = z.string().regex(/^[a-f0-9]{64}$/)
const answerValues = z.array(z.array(z.string().max(20_000)).max(101)).min(1).max(32)
    .refine(answers => answers.flat().reduce((length, answer) => length + answer.length, 0) <= 20_000, 'Keep the answers under 20,000 characters.')
const answer = z.object({ action: z.literal('answer'), answers: answerValues, documents: desktopDocumentSendSelectionSchema.optional() }).strict()
const cancel = z.object({ action: z.literal('cancel') }).strict()
export const desktopQuestionPayloadSchema = z.discriminatedUnion('action', [answer, cancel])
export const desktopQuestionAnswerSchema = z.discriminatedUnion('action', [
    answer.extend({ questionId, requestId: z.string().uuid() }).strict(),
    cancel.extend({ questionId, requestId: z.string().uuid() }).strict(),
])
export type DesktopQuestionAnswer = z.infer<typeof desktopQuestionAnswerSchema>
export type DesktopQuestionPayload = z.infer<typeof desktopQuestionPayloadSchema>

// Additive presentation compatibility only: pending question IDs and receipt fingerprints
// continue to come from the untouched engine question/guard, never from this view schema.
const questionOption = z.object({ label: z.string(), description: z.string().optional() }).strict()
const questionItem = z.object({ question: z.string(), header: z.string().optional(), options: z.array(z.union([z.string(), questionOption])), multiple: z.boolean().optional() })
export const desktopPendingQuestionSchema = z.object({
    id: questionId,
    messageId: z.string().min(1),
    toolCallId: z.string().min(1),
    questions: z.array(questionItem).min(1).max(32),
    // The source request message's own timestamp: the pending request's age and order, not the
    // chat's latest activity.
    requestedAt: z.string().optional(),
    attempt: z.discriminatedUnion('action', [answer.extend({ requestId: z.string().uuid() }), cancel.extend({ requestId: z.string().uuid() })]).optional(),
})
export const desktopQuestionViewSchema = z.object({ question: desktopPendingQuestionSchema.nullable() })
export type DesktopPendingQuestion = z.infer<typeof desktopPendingQuestionSchema>
export type DesktopQuestionView = z.infer<typeof desktopQuestionViewSchema>
