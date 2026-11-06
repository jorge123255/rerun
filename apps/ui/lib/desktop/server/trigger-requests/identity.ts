import 'server-only'
import { createHash } from 'node:crypto'
import { triggerRequestLinkSchema, type TriggerRequestDecision, type TriggerRequestLink } from '../../trigger-requests/types'

export function triggerRequestKey(link: TriggerRequestLink): string {
    const source = triggerRequestLinkSchema.parse(link)
    return createHash('sha256').update(JSON.stringify([
        'desktop.webhook.human.v1', source.workspaceId, source.agentId, source.engineAgentId,
        source.eventId, source.slug, source.sessionId, source.engineSessionId, source.triggerRunId,
        source.sourceRunId, source.kind, source.requestId, source.sourceMessageId, source.toolCallId, source.fingerprint,
    ])).digest('hex')
}
export function continuationId(link: TriggerRequestLink): string {
    const hex = createHash('sha256').update('desktop.webhook.followup.v1\0' + triggerRequestKey(link)).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export function decisionDigest(decision: TriggerRequestDecision): string {
    // A credential's values and even hashes of those values never enter this journal.
    const input = decision.kind === 'secret' ? { ...decision.input, values: undefined, attemptId: undefined }
        : { ...decision.input, requestId: undefined }
    return createHash('sha256').update(JSON.stringify([decision.kind, input])).digest('hex')
}
export function bindDecision(decision: TriggerRequestDecision, requestId: string): TriggerRequestDecision {
    if (decision.kind === 'secret') return { ...decision, input: { ...decision.input, attemptId: requestId } }
    return { ...decision, input: { ...decision.input, requestId } } as TriggerRequestDecision
}

export function stopRequestId(link: TriggerRequestLink): string {
    const hex = createHash('sha256').update('desktop.webhook.stop.v1\0' + triggerRequestKey(link)).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
