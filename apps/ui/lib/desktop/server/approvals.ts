import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { desktopApprovalGuardSchema, findDesktopApproval, serializeApprovalDecisions, type DesktopApprovalGuard } from '@rerun/contracts'
import { chat, EngineRequestError, getSessionMessages } from '@/lib/engine/client'
import { desktopApprovalPayloadSchema, type DesktopApprovalAnswer, type DesktopApprovalPayload, type DesktopApprovalView } from '../approvals'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { disabledCoworkerMessage } from './coworker-enabled'
import { openDesktopDatabase } from './database'
import { startDesktopChat } from './engine'
import { withRosterWrite } from './roster-writes'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession, type DesktopAgent, type DesktopSession } from './store'

type Approval = NonNullable<ReturnType<typeof findDesktopApproval>>
type Target = { db: Client; agent: DesktopAgent; session: DesktopSession }
type Receipt = { requestId: string; agentId: string; sessionId: string; approvalId: string; guard: DesktopApprovalGuard; payload: DesktopApprovalPayload; text: string; accepted: boolean }
const answerLocks = globalThis as typeof globalThis & { desktopApprovalWrites?: Map<string, Promise<void>> }

function withAnswerWrite<T>(key: string, action: () => Promise<T>): Promise<T> {
    const locks = answerLocks.desktopApprovalWrites ??= new Map()
    const result = (locks.get(key) ?? Promise.resolve()).then(action)
    const settled = result.then(() => {}, () => {})
    locks.set(key, settled)
    void settled.then(() => { if (locks.get(key) === settled) locks.delete(key) })
    return result
}

async function targetOf(runtime: DesktopRuntime, sessionId: string): Promise<Target> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    await assertCoworkerNotDeleting(db, session.agentId)
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { db, agent, session }
}

function identity(target: Target, approval: Approval): string {
    return createHash('sha256').update(JSON.stringify(['approval', target.agent.id, target.session.id, approval.sourceMessageId, approval.toolCallId, approval.fingerprint])).digest('hex')
}

async function pendingApproval(runtime: DesktopRuntime, target: Target, options: { signal?: AbortSignal } = {}): Promise<Approval | null> {
    try {
        const messages = await getSessionMessages(engineOf(runtime), target.agent.engineAgentId, target.session.engineSessionId, { requireSuccess: true, ...(options.signal && { signal: options.signal }) })
        if (messages.some(message => message.sessionId !== target.session.engineSessionId)) throw new Error('Foreign conversation history')
        return findDesktopApproval(messages)
    } catch (cause) {
        if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        throw new DesktopHttpError(502, 'Could not read this coworker’s approval request. Try again.')
    }
}

function receiptOf(row: Row): Receipt {
    return { requestId: String(row.request_id), agentId: String(row.agent_id), sessionId: String(row.session_id), approvalId: String(row.approval_id),
        guard: desktopApprovalGuardSchema.parse(JSON.parse(String(row.approval_guard))), payload: desktopApprovalPayloadSchema.parse(JSON.parse(String(row.payload))),
        text: String(row.answer_text), accepted: Number(row.accepted) === 1 }
}

async function byApproval(db: Client, sessionId: string, approvalId: string): Promise<Receipt | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_approval_answers WHERE session_id = ? AND approval_id = ?', args: [sessionId, approvalId] })
    return result.rows[0] ? receiptOf(result.rows[0]) : null
}

async function byRequest(db: Client, requestId: string): Promise<Receipt | null> {
    const result = await db.execute({ sql: 'SELECT a.* FROM desktop_approval_requests r JOIN desktop_approval_answers a ON a.request_id = r.answer_id WHERE r.request_id = ?', args: [requestId] })
    return result.rows[0] ? receiptOf(result.rows[0]) : null
}

function payloadOf(input: DesktopApprovalAnswer): DesktopApprovalPayload {
    return { decisions: input.decisions.map(item => item.decision === 'approved' ? { decision: 'approved' } :
        { decision: 'declined', ...(item.note?.trim() && { note: item.note.trim() }) }) }
}

function verifyReceipt(receipt: Receipt, target: Target, input: DesktopApprovalAnswer, payload: DesktopApprovalPayload) {
    if (receipt.agentId !== target.agent.id || receipt.sessionId !== target.session.id || receipt.approvalId !== input.approvalId) throw new DesktopHttpError(409, 'That decision request belongs to a different approval or conversation.')
    if (JSON.stringify(receipt.payload) !== JSON.stringify(payload)) throw new DesktopHttpError(409, 'Decisions are already saved for this approval. Retry those decisions instead of changing them.')
}

function answerText(approval: Approval, payload: DesktopApprovalPayload): string {
    if (payload.decisions.length !== approval.approvals.length) throw new DesktopHttpError(400, 'Approve or decline each action in this form.')
    return serializeApprovalDecisions(approval.approvals.map((item, index) => ({ ...item, ...payload.decisions[index] })))
}

// History filters use the same read-only saved-history resolver. An approval completes its
// original turn; its decision starts a later user turn, without changing any execution grant.
export async function readDesktopApproval(runtime: DesktopRuntime, sessionId: string, options: { signal?: AbortSignal } = {}): Promise<DesktopApprovalView> {
    const target = await targetOf(runtime, sessionId)
    const pending = await pendingApproval(runtime, target, options)
    if (!pending) return { approval: null }
    const id = identity(target, pending)
    const receipt = await byApproval(target.db, sessionId, id)
    if (receipt?.accepted) return { approval: null }
    return { approval: { id, messageId: pending.sourceMessageId, toolCallId: pending.toolCallId, approvals: pending.approvals,
        ...(receipt && { attempt: { ...receipt.payload, requestId: receipt.requestId } }),
    } }
}

function identified(response: Response, receipt: Receipt) {
    response.headers.set('x-approval-id', receipt.approvalId)
    return response
}

function acceptedResponse(receipt: Receipt) {
    return identified(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': receipt.sessionId, 'x-run-id': receipt.requestId } }), receipt)
}

async function markAccepted(db: Client, receipt: Receipt) {
    await db.execute({ sql: 'UPDATE desktop_approval_answers SET accepted = 1 WHERE request_id = ? AND session_id = ? AND approval_id = ?', args: [receipt.requestId, receipt.sessionId, receipt.approvalId] })
}

// Reconcile before checking pending state, model availability or enabled state. The accepted
// decision is precisely what makes the old approval stop being pending after a lost response.
async function reconcile(runtime: DesktopRuntime, target: Target, receipt: Receipt): Promise<Response | null> {
    if (receipt.accepted) return acceptedResponse(receipt)
    let response: Response
    try {
        response = await chat(engineOf(runtime), target.agent.engineAgentId, { sessionId: target.session.engineSessionId, message: receipt.text,
            desktopQueuedTurn: { runId: receipt.requestId, replayOnly: true, approval: receipt.guard }, source: 'dashboard' })
    } catch { throw new DesktopHttpError(502, 'Could not check whether these decisions were sent. Retry the same decisions.') }
    if (response.status === 404 && (await response.clone().json().catch(() => ({}))).code === 'queued_turn_not_found') return null
    if (response.status === 403) throw new DesktopHttpError(403, disabledCoworkerMessage)
    if (!response.ok || response.headers.get('x-session-id') !== target.session.engineSessionId || response.headers.get('x-run-id') !== receipt.requestId) throw new DesktopHttpError(502, 'Could not confirm these decisions. Retry the same decisions.')
    if (response.status !== 204 && !response.body) throw new DesktopHttpError(502, 'Could not read the reply to these decisions. Retry the same decisions.')
    await markAccepted(target.db, receipt)
    const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'text/event-stream',
        'x-vercel-ai-ui-message-stream': response.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1', 'x-session-id': target.session.id, 'x-run-id': receipt.requestId })
    return identified(new Response(response.status === 204 ? 'data: [DONE]\n\n' : response.body, { status: 200, headers }), receipt)
}

async function reserve(target: Target, input: DesktopApprovalAnswer, payload: DesktopApprovalPayload, pending?: Approval): Promise<Receipt> {
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(target.db, target.agent.id)
        const existing = await byRequest(target.db, input.requestId) ?? await byApproval(target.db, target.session.id, input.approvalId)
        if (existing) {
            verifyReceipt(existing, target, input, payload)
            await target.db.execute({ sql: 'INSERT INTO desktop_approval_requests (request_id, answer_id) VALUES (?,?) ON CONFLICT(request_id) DO NOTHING', args: [input.requestId, existing.requestId] })
            return existing
        }
        if (!pending || identity(target, pending) !== input.approvalId) throw new DesktopHttpError(409, 'This approval is no longer waiting for decisions. Reload the conversation.')
        const text = answerText(pending, payload)
        const guard = { sourceMessageId: pending.sourceMessageId, toolCallId: pending.toolCallId, fingerprint: pending.fingerprint }
        await target.db.batch([
            { sql: 'INSERT INTO desktop_approval_answers (request_id,agent_id,session_id,approval_id,approval_guard,payload,answer_text,created_at) VALUES (?,?,?,?,?,?,?,?)', args: [input.requestId, target.agent.id, target.session.id, input.approvalId, JSON.stringify(guard), JSON.stringify(payload), text, new Date().toISOString()] },
            { sql: 'INSERT INTO desktop_approval_requests (request_id,answer_id) VALUES (?,?)', args: [input.requestId, input.requestId] },
        ], 'write')
        return { requestId: input.requestId, agentId: target.agent.id, sessionId: target.session.id, approvalId: input.approvalId, guard, payload, text, accepted: false }
    })
}

export function answerDesktopApproval(runtime: DesktopRuntime, sessionId: string, input: DesktopApprovalAnswer): Promise<Response> {
    return withAnswerWrite(runtime.dataRoot + '\0' + sessionId, async () => {
        const target = await targetOf(runtime, sessionId)
        const payload = payloadOf(input)
        const known = await byRequest(target.db, input.requestId) ?? await byApproval(target.db, sessionId, input.approvalId)
        let receipt: Receipt
        if (known) {
            verifyReceipt(known, target, input, payload)
            receipt = await reserve(target, input, payload)
            const replay = await reconcile(runtime, target, receipt)
            if (replay) return replay
        } else {
            const pending = await pendingApproval(runtime, target)
            if (!pending || identity(target, pending) !== input.approvalId) throw new DesktopHttpError(409, 'This approval is no longer waiting for decisions. Reload the conversation.')
            receipt = await reserve(target, input, payload, pending)
        }
        if (!target.agent.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
        // The engine checks this immutable approval again under its session admission lock;
        // a concurrent ordinary chat, question answer or later approval cannot be mistaken for it.
        const result = await startDesktopChat(runtime, { agentId: target.agent.id, sessionId, text: receipt.text, requestId: receipt.requestId, approval: receipt.guard })
        await markAccepted(target.db, receipt)
        return identified(result.response, receipt)
    })
}
