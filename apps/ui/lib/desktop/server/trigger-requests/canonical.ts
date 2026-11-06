import 'server-only'
import type { Client } from '@libsql/client'
import type { DesktopSecretRequestView, DesktopTriggerDeliveryReceipt } from '@rerun/contracts'
import { answerDesktopQuestion, readDesktopQuestion } from '../questions'
import { answerDesktopApproval, readDesktopApproval } from '../approvals'
import { answerDesktopTakeover, readDesktopTakeover } from '../takeover'
import { readDesktopServiceRequestView } from '../service-requests/view'
import { desktopServiceRequestPorts, desktopServiceRequestScope } from '../service-requests/route-context'
import { finishDesktopServiceRequest } from '../service-requests/service'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'
import { canonicalRequestId, type TriggerRequestDecision, type TriggerRequestForm, type TriggerRequestLink, type TriggerRequestReceipt, type TriggerRequestTarget } from '../../trigger-requests/types'
import type { TriggerRequestRecord } from './journal'

export type TriggerRequestRootBindings = {
    readContinuationRuns?: (link: TriggerRequestTarget, signal: AbortSignal) => Promise<string[]>
    workspaceIdentity: string
    resolveSessionSource: (sessionId: string, signal: AbortSignal) => Promise<{ kind: 'ordinary' } | { kind: 'trigger'; target: TriggerRequestTarget } | { kind: 'unavailable' }>
    readDelivery: (engineAgentId: string, eventId: string, signal: AbortSignal) => Promise<DesktopTriggerDeliveryReceipt | null>
    withDecisionClaim: <T>(link: TriggerRequestLink, work: () => Promise<T>) => Promise<T>
    assertCurrentRequestPermission: (link: TriggerRequestLink, signal: AbortSignal) => Promise<void>
    stop: (row: TriggerRequestRecord, signal: AbortSignal) => Promise<void>
    stopReceipt: (row: TriggerRequestRecord, signal: AbortSignal) => Promise<'stopped' | 'unknown'>
    secret?: {
        read: (sessionId: string, signal: AbortSignal) => Promise<DesktopSecretRequestView | null>
        probe?: (row: TriggerRequestRecord, signal: AbortSignal) => Promise<TriggerRequestReceipt>
        decide: (sessionId: string, input: Extract<TriggerRequestDecision, { kind: 'secret' }>['input'], signal: AbortSignal) => Promise<Response>
    }
    signIn?: {
        read: (sessionId: string, signal: AbortSignal) => Promise<{ requestId: string; sourceMessageId: string; toolCallId: string; fingerprint: string; name: string; reason: string } | null>
    }
}
export class MissingTriggerRequestAuthority extends DesktopHttpError {
    constructor(name: string) { super(503, `Webhook human requests require root authority: ${name}`) }
}
export async function readCanonicalTriggerForm(runtime: DesktopRuntime, root: TriggerRequestRootBindings, sessionId: string, signal: AbortSignal): Promise<TriggerRequestForm | null> {
    const forms: TriggerRequestForm[] = []
    const question = (await readDesktopQuestion(runtime, sessionId, { signal })).question
    if (question) forms.push({ kind: 'question', value: question })
    const approval = (await readDesktopApproval(runtime, sessionId, { signal })).approval
    if (approval) forms.push({ kind: 'approval', value: approval })
    const takeover = (await readDesktopTakeover(runtime, sessionId, { signal })).takeover
    if (takeover) forms.push({ kind: 'takeover', value: takeover })
    const service = (await readDesktopServiceRequestView(runtime, sessionId, { signal })).request
    if (service && !service.receipt?.accepted && service.retry.phase !== 'accepted') forms.push({ kind: 'service', value: service })
    const secret = await root.secret?.read(sessionId, signal)
    if (secret && secret.status !== 'accepted') forms.push({ kind: 'secret', value: secret })
    const signIn = await root.signIn?.read(sessionId, signal)
    if (signIn) forms.push({ kind: 'signin', value: signIn })
    signal.throwIfAborted()
    if (forms.length > 1) throw new DesktopHttpError(409, 'The pending request changed during the read. Refresh this chat.')
    return forms[0] ?? null
}
export async function invokeCanonicalTriggerDecision(runtime: DesktopRuntime, root: TriggerRequestRootBindings, row: TriggerRequestRecord, decision: TriggerRequestDecision, signal: AbortSignal): Promise<Response> {
    if (decision.kind !== row.link.kind || canonicalRequestId(decision) !== row.link.requestId) throw new DesktopHttpError(409, 'Webhook decision source changed')
    switch (decision.kind) {
        case 'question': return answerDesktopQuestion(runtime, row.link.sessionId, decision.input)
        case 'approval': return answerDesktopApproval(runtime, row.link.sessionId, decision.input)
        case 'takeover': {
            if (decision.input.action !== 'done' && decision.input.action !== 'skip') throw new DesktopHttpError(400, 'Use the existing browser lease authority')
            return answerDesktopTakeover(runtime, row.link.sessionId, decision.input)
        }
        case 'service': {
            const bound = await desktopServiceRequestScope(runtime, row.link.sessionId)
            return finishDesktopServiceRequest(bound.db, bound.scope, desktopServiceRequestPorts(runtime, bound, signal), decision.input)
        }
        case 'secret': {
            if (!root.secret) throw new MissingTriggerRequestAuthority('desktopSecretRequestPorts.read/decide')
            const source = decision.input.source
            if (source.agentId !== row.link.agentId || source.sessionId !== row.link.sessionId || source.runId !== row.link.sourceRunId || source.sourceMessageId !== row.link.sourceMessageId || source.toolCallId !== row.link.toolCallId || source.fingerprint !== row.link.fingerprint) throw new DesktopHttpError(409, 'Credential request source changed')
            return root.secret.decide(row.link.sessionId, decision.input, signal)
        }
    }
}
export async function readCanonicalTriggerReceipt(db: Client, row: TriggerRequestRecord): Promise<TriggerRequestReceipt> {
    const link = row.link
    // Read only metadata. Never select answer text, decision payloads, sealed values or tokens.
    try {
        let found: { requestId: string; accepted: boolean } | null = null
        if (link.kind === 'question' || link.kind === 'approval' || link.kind === 'takeover') {
            const tables = { question: ['desktop_question_answers', 'question_id'], approval: ['desktop_approval_answers', 'approval_id'], takeover: ['desktop_takeover_answers', 'takeover_id'] } as const
            const [table, column] = tables[link.kind]
            const receipt = (await db.execute({ sql: `SELECT request_id,accepted FROM ${table} WHERE agent_id=? AND session_id=? AND ${column}=?`, args: [link.agentId, link.sessionId, link.requestId] })).rows[0]
            if (receipt) found = { requestId: String(receipt.request_id), accepted: Number(receipt.accepted) === 1 }
        } else if (link.kind === 'service') {
            const receipt = (await db.execute({ sql: `SELECT r.request_id,r.accepted FROM desktop_service_suggestion_receipts r JOIN desktop_service_suggestion_requests s ON s.service_request_id=r.service_request_id WHERE s.agent_id=? AND s.session_id=? AND s.service_request_id=? AND s.source_message_id=? AND s.tool_call_id=?`, args: [link.agentId, link.sessionId, link.requestId, link.sourceMessageId, link.toolCallId] })).rows[0]
            if (receipt) found = { requestId: String(receipt.request_id), accepted: Number(receipt.accepted) === 1 }
        } else if (link.kind === 'secret') {
            const receipt = (await db.execute({ sql: `SELECT r.continuation_request_id,r.accepted FROM desktop_secret_receipts r JOIN desktop_secret_requests s ON s.request_id=r.request_id WHERE s.agent_id=? AND s.session_id=? AND s.request_id=? AND s.source_message_id=? AND s.tool_call_id=? AND s.fingerprint=?`, args: [link.agentId, link.sessionId, link.requestId, link.sourceMessageId, link.toolCallId, link.fingerprint] })).rows[0]
            if (receipt) found = { requestId: String(receipt.continuation_request_id), accepted: Number(receipt.accepted) === 1 }
        } else return { status: 'unknown' }
        if (!found && link.kind === 'secret') {
            const attempt = (await db.execute({ sql: `SELECT a.state FROM desktop_secret_attempts a JOIN desktop_secret_requests s ON s.request_id=a.request_id WHERE s.agent_id=? AND s.session_id=? AND s.request_id=? AND a.state IN ('staged','sealed') LIMIT 1`, args: [link.agentId, link.sessionId, link.requestId] })).rows[0]
            if (attempt) return { status: 'reserved' }
        }
        if (!found) return { status: 'absent' }
        return found.accepted ? { status: 'accepted', continuationId: found.requestId } : { status: 'reserved' }
    } catch { return { status: 'unknown' } }
}
