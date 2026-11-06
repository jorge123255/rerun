import { z } from 'zod'
import { desktopSecretRequestDecisionSchema, desktopSecretRequestViewSchema, desktopServiceFinishSchema, desktopServiceRequestViewSchema } from '@rerun/contracts'
import { desktopQuestionAnswerSchema, desktopPendingQuestionSchema } from '../questions'
import { desktopApprovalAnswerSchema, desktopPendingApprovalSchema } from '../approvals'
import { desktopTakeoverActionSchema, desktopTakeoverViewSchema } from '../takeover'

const id = z.string().min(1).max(256)
export const triggerRequestLinkSchema = z.strictObject({
    workspaceId: id, agentId: id, engineAgentId: id, eventId: id, slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    sessionId: id, engineSessionId: id, triggerRunId: id, sourceRunId: id,
    kind: z.enum(['question', 'approval', 'service', 'secret', 'signin', 'takeover']),
    requestId: id, sourceMessageId: id, toolCallId: id, fingerprint: z.string().min(1).max(65536),
})
export type TriggerRequestLink = z.infer<typeof triggerRequestLinkSchema>
export const triggerRequestDecisionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('question'), input: desktopQuestionAnswerSchema }),
    z.strictObject({ kind: z.literal('approval'), input: desktopApprovalAnswerSchema }),
    z.strictObject({ kind: z.literal('service'), input: desktopServiceFinishSchema }),
    z.strictObject({ kind: z.literal('secret'), input: desktopSecretRequestDecisionSchema }),
    z.strictObject({ kind: z.literal('takeover'), input: desktopTakeoverActionSchema.refine(value => value.action === 'done' || value.action === 'skip', 'Use the existing viewer for opening and releasing input.') }),
])
export type TriggerRequestDecision = z.infer<typeof triggerRequestDecisionSchema>
export const triggerRequestFormSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('question'), value: desktopPendingQuestionSchema }),
    z.strictObject({ kind: z.literal('approval'), value: desktopPendingApprovalSchema }),
    z.strictObject({ kind: z.literal('service'), value: desktopServiceRequestViewSchema.shape.request.unwrap() }),
    z.strictObject({ kind: z.literal('secret'), value: desktopSecretRequestViewSchema }),
    z.strictObject({ kind: z.literal('takeover'), value: desktopTakeoverViewSchema.shape.takeover.unwrap() }),
    z.strictObject({ kind: z.literal('signin'), value: z.strictObject({ requestId: id, sourceMessageId: id, toolCallId: id, fingerprint: z.string().min(1).max(65536), name: id, reason: z.string().max(500) }) }),
])
export type TriggerRequestForm = z.infer<typeof triggerRequestFormSchema>
export type TriggerRequestObservation = {
    link: TriggerRequestLink
    runStatus: 'running' | 'done' | 'error' | 'cancelled'
    availability: 'ready' | 'disabled' | 'deleted-trigger' | 'revoked' | 'stopped' | 'superseded' | 'unavailable'
    request: TriggerRequestForm | null
    canonicalAttemptId?: string
}
export const triggerRequestPhaseSchema = z.enum(['pending', 'uncertain', 'accepted', 'superseded', 'stop-uncertain', 'stopped'])
export type TriggerRequestPhase = z.infer<typeof triggerRequestPhaseSchema>
export const triggerRequestViewSchema = z.strictObject({
    key: z.string().regex(/^[a-f0-9]{64}$/), link: triggerRequestLinkSchema,
    phase: triggerRequestPhaseSchema, continuationId: id, acceptedRunId: id.nullable(),
    runStatus: z.enum(['running', 'done', 'error', 'cancelled']),
    availability: z.enum(['ready', 'disabled', 'deleted-trigger', 'revoked', 'stopped', 'superseded', 'unavailable']),
    request: triggerRequestFormSchema.nullable(),
})
export type TriggerRequestView = z.infer<typeof triggerRequestViewSchema>
export type TriggerRequestReceipt =
    | { status: 'accepted'; continuationId: string }
    | { status: 'reserved' | 'absent' | 'unknown' }
export type TriggerRequestTarget = Pick<TriggerRequestLink, 'workspaceId' | 'agentId' | 'engineAgentId' | 'eventId' | 'slug' | 'sessionId' | 'engineSessionId' | 'triggerRunId'>

export function canonicalRequestId(decision: TriggerRequestDecision): string {
    switch (decision.kind) {
        case 'question': return decision.input.questionId
        case 'approval': return decision.input.approvalId
        case 'service': return decision.input.serviceRequestId
        case 'secret': return decision.input.requestId
        case 'takeover': return decision.input.takeoverId
    }
}
