import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { desktopTakeoverGuardSchema, findDesktopTakeover, serializeTakeoverResult, HITL_CANCELLED, type DesktopTakeoverGuard } from '@rerun/contracts'
import { chat, EngineRequestError, getSessionMessages } from '@/lib/engine/client'
import { z } from 'zod'
import type { DesktopTakeoverAction, DesktopTakeoverTerminal, DesktopTakeoverView } from '../takeover'
import { desktopScreenTakeover, desktopScreenFinishTakeover } from './screen/service'
const desktopTakeoverPayloadSchema = z.object({ action: z.enum(['done', 'skip']) }).strict()
type DesktopTakeoverPayload = z.infer<typeof desktopTakeoverPayloadSchema>
type DesktopTakeoverAnswer = DesktopTakeoverTerminal
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { disabledCoworkerMessage } from './coworker-enabled'
import { openDesktopDatabase } from './database'
import { startDesktopChat } from './engine'
import { withRosterWrite } from './roster-writes'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession, type DesktopAgent, type DesktopSession } from './store'

type Takeover = NonNullable<ReturnType<typeof findDesktopTakeover>>
type Target = { db: Client; agent: DesktopAgent; session: DesktopSession }
type Receipt = { requestId: string; agentId: string; sessionId: string; takeoverId: string; guard: DesktopTakeoverGuard; payload: DesktopTakeoverPayload; text: string; accepted: boolean }
const answerLocks = globalThis as typeof globalThis & { desktopTakeoverWrites?: Map<string, Promise<void>> }

function withAnswerWrite<T>(key: string, action: () => Promise<T>): Promise<T> {
    const locks = answerLocks.desktopTakeoverWrites ??= new Map()
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

function identity(target: Target, takeover: Takeover): string {
    return createHash('sha256').update(JSON.stringify(['takeover', target.agent.id, target.session.id, takeover.sourceMessageId, takeover.toolCallId, takeover.fingerprint])).digest('hex')
}

async function pendingTakeover(runtime: DesktopRuntime, target: Target, options: { signal?: AbortSignal } = {}): Promise<Takeover | null> {
    try {
        const messages = await getSessionMessages(engineOf(runtime), target.agent.engineAgentId, target.session.engineSessionId, { requireSuccess: true, ...(options.signal && { signal: options.signal }) })
        if (messages.some(message => message.sessionId !== target.session.engineSessionId)) throw new Error('Foreign conversation history')
        return findDesktopTakeover(messages)
    } catch (cause) {
        if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        throw new DesktopHttpError(502, 'Could not read this coworker’s takeover request. Try again.')
    }
}

function receiptOf(row: Row): Receipt {
    return { requestId: String(row.request_id), agentId: String(row.agent_id), sessionId: String(row.session_id), takeoverId: String(row.takeover_id),
        guard: desktopTakeoverGuardSchema.parse(JSON.parse(String(row.takeover_guard))), payload: desktopTakeoverPayloadSchema.parse(JSON.parse(String(row.payload))),
        text: String(row.answer_text), accepted: Number(row.accepted) === 1 }
}

async function byTakeover(db: Client, sessionId: string, takeoverId: string): Promise<Receipt | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_takeover_answers WHERE session_id = ? AND takeover_id = ?', args: [sessionId, takeoverId] })
    return result.rows[0] ? receiptOf(result.rows[0]) : null
}

async function byRequest(db: Client, requestId: string): Promise<Receipt | null> {
    const result = await db.execute({ sql: 'SELECT a.* FROM desktop_takeover_requests r JOIN desktop_takeover_answers a ON a.request_id = r.answer_id WHERE r.request_id = ?', args: [requestId] })
    return result.rows[0] ? receiptOf(result.rows[0]) : null
}

function payloadOf(input: DesktopTakeoverAnswer): DesktopTakeoverPayload { return { action: input.action } }

function verifyReceipt(receipt: Receipt, target: Target, input: DesktopTakeoverAnswer, payload: DesktopTakeoverPayload) {
    if (receipt.agentId !== target.agent.id || receipt.sessionId !== target.session.id || receipt.takeoverId !== input.takeoverId) throw new DesktopHttpError(409, 'That decision request belongs to a different takeover or conversation.')
    if (JSON.stringify(receipt.payload) !== JSON.stringify(payload)) throw new DesktopHttpError(409, 'Decisions are already saved for this takeover. Retry those decisions instead of changing them.')
}

async function answerText(runtime: DesktopRuntime, target: Target, input: DesktopTakeoverAnswer): Promise<string> {
    const screen = (await target.db.execute({ sql: 'SELECT * FROM desktop_takeover_screens WHERE takeover_id = ? AND session_id = ? AND agent_id = ?', args: [input.takeoverId, target.session.id, target.agent.id] })).rows[0]
    if (input.action === 'done' && (!screen || screen.launch_nonce !== runtime.launchNonce)) throw new DesktopHttpError(409, 'Reopen this request’s browser before pressing Done.')
    let url: string | null = screen?.result_url == null ? null : String(screen.result_url)
    if (screen && screen.launch_nonce === runtime.launchNonce && !Number(screen.released)) {
        const result = await desktopScreenFinishTakeover(runtime, target.agent.id, String(screen.lease), AbortSignal.timeout(15_000))
        if (result.expired && input.action === 'done') throw new DesktopHttpError(409, 'Browser control expired. Reopen the screen before pressing Done.')
        url = result.url
        if (!result.expired) await target.db.execute({ sql: 'UPDATE desktop_takeover_screens SET released=1,result_url=? WHERE takeover_id=? AND lease=?', args: [url, input.takeoverId, screen.lease] })
    }
    return input.action === 'skip' ? HITL_CANCELLED.takeover : serializeTakeoverResult(url)
}

// History filters use the same read-only saved-history resolver. An takeover completes its
// original turn; its decision starts a later user turn, without changing any execution grant.
export async function readDesktopTakeover(runtime: DesktopRuntime, sessionId: string, options: { signal?: AbortSignal } = {}): Promise<DesktopTakeoverView> {
    const target = await targetOf(runtime, sessionId)
    const pending = await pendingTakeover(runtime, target, options)
    if (!pending) return { takeover: null }
    const id = identity(target, pending)
    const receipt = await byTakeover(target.db, sessionId, id)
    if (receipt?.accepted) return { takeover: null }
    return { takeover: { id, messageId: pending.sourceMessageId, toolCallId: pending.toolCallId, url: pending.url, reason: pending.reason, opened: false,
        ...(pending.requestedAt ? { requestedAt: pending.requestedAt } : {}),
        ...(receipt && { attempt: { ...receipt.payload, requestId: receipt.requestId, takeoverId: id } }),
    } }
}

function identified(response: Response, receipt: Receipt) {
    response.headers.set('x-takeover-id', receipt.takeoverId)
    return response
}

function acceptedResponse(receipt: Receipt) {
    return identified(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': receipt.sessionId, 'x-run-id': receipt.requestId } }), receipt)
}

async function markAccepted(db: Client, receipt: Receipt) {
    await db.execute({ sql: 'UPDATE desktop_takeover_answers SET accepted = 1 WHERE request_id = ? AND session_id = ? AND takeover_id = ?', args: [receipt.requestId, receipt.sessionId, receipt.takeoverId] })
}

// Reconcile before checking pending state, model availability or enabled state. The accepted
// decision is precisely what makes the old takeover stop being pending after a lost response.
async function reconcile(runtime: DesktopRuntime, target: Target, receipt: Receipt): Promise<Response | null> {
    if (receipt.accepted) return acceptedResponse(receipt)
    let response: Response
    try {
        response = await chat(engineOf(runtime), target.agent.engineAgentId, { sessionId: target.session.engineSessionId, message: receipt.text,
            desktopQueuedTurn: { runId: receipt.requestId, replayOnly: true, takeover: receipt.guard }, source: 'dashboard' })
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

async function reserve(target: Target, input: DesktopTakeoverAnswer, payload: DesktopTakeoverPayload, pending?: Takeover, answer?: string): Promise<Receipt> {
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(target.db, target.agent.id)
        const existing = await byRequest(target.db, input.requestId) ?? await byTakeover(target.db, target.session.id, input.takeoverId)
        if (existing) {
            verifyReceipt(existing, target, input, payload)
            await target.db.execute({ sql: 'INSERT INTO desktop_takeover_requests (request_id, answer_id) VALUES (?,?) ON CONFLICT(request_id) DO NOTHING', args: [input.requestId, existing.requestId] })
            const alias = await byRequest(target.db, input.requestId)
            if (!alias) throw new DesktopHttpError(409, 'Could not confirm this browser decision.')
            verifyReceipt(alias, target, input, payload)
            return existing
        }
        if (!pending || identity(target, pending) !== input.takeoverId) throw new DesktopHttpError(409, 'This takeover is no longer waiting for decisions. Reload the conversation.')
        if (answer === undefined) throw new DesktopHttpError(409, 'The browser decision was not prepared.')
        const text = answer
        const guard = { sourceMessageId: pending.sourceMessageId, toolCallId: pending.toolCallId, fingerprint: pending.fingerprint }
        await target.db.batch([
            { sql: 'INSERT INTO desktop_takeover_answers (request_id,agent_id,session_id,takeover_id,takeover_guard,payload,answer_text,created_at) VALUES (?,?,?,?,?,?,?,?)', args: [input.requestId, target.agent.id, target.session.id, input.takeoverId, JSON.stringify(guard), JSON.stringify(payload), text, new Date().toISOString()] },
            { sql: 'INSERT INTO desktop_takeover_requests (request_id,answer_id) VALUES (?,?)', args: [input.requestId, input.requestId] },
        ], 'write')
        return { requestId: input.requestId, agentId: target.agent.id, sessionId: target.session.id, takeoverId: input.takeoverId, guard, payload, text, accepted: false }
    })
}

async function answerTerminal(runtime: DesktopRuntime, sessionId: string, input: DesktopTakeoverAnswer): Promise<Response> {
    return withAnswerWrite(runtime.dataRoot + '\0' + sessionId, async () => {
        const target = await targetOf(runtime, sessionId)
        const payload = payloadOf(input)
        const known = await byRequest(target.db, input.requestId) ?? await byTakeover(target.db, sessionId, input.takeoverId)
        let receipt: Receipt
        if (known) {
            verifyReceipt(known, target, input, payload)
            receipt = await reserve(target, input, payload)
            const replay = await reconcile(runtime, target, receipt)
            if (replay) return replay
        } else {
            const pending = await pendingTakeover(runtime, target)
            if (!pending || identity(target, pending) !== input.takeoverId) throw new DesktopHttpError(409, 'This takeover is no longer waiting for decisions. Reload the conversation.')
            receipt = await reserve(target, input, payload, pending, await answerText(runtime, target, input))
        }
        if (!target.agent.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
        // The engine checks this immutable takeover again under its session admission lock;
        // a concurrent ordinary chat, question answer or later takeover cannot be mistaken for it.
        const result = await startDesktopChat(runtime, { agentId: target.agent.id, sessionId, text: receipt.text, requestId: receipt.requestId, takeover: receipt.guard })
        await markAccepted(target.db, receipt)
        return identified(result.response, receipt)
    })
}

export async function answerDesktopTakeover(runtime: DesktopRuntime, sessionId: string, input: DesktopTakeoverAction): Promise<Response> {
    const target = await targetOf(runtime, sessionId)
    // A coworker's sibling chats share its browser. Serialize ownership changes by coworker.
    return withAnswerWrite(runtime.dataRoot + '\0screen:' + target.agent.id, async () => {
        if (input.action === 'done' || input.action === 'skip') return answerTerminal(runtime, sessionId, input)
        const existing = (await target.db.execute({ sql: 'SELECT * FROM desktop_takeover_screens WHERE takeover_id=? AND session_id=? AND agent_id=?', args: [input.takeoverId, sessionId, target.agent.id] })).rows[0]
        if (input.action === 'release') {
            if (!existing || existing.lease !== input.lease || existing.launch_nonce !== runtime.launchNonce) return Response.json({ url: null, expired: true })
            if (Number(existing.released)) return Response.json({ url: existing.result_url })
            const result = await desktopScreenFinishTakeover(runtime, target.agent.id, input.lease, AbortSignal.timeout(15_000))
            if (!result.expired) await target.db.execute({ sql: 'UPDATE desktop_takeover_screens SET released=1,result_url=? WHERE takeover_id=? AND lease=?', args: [result.url, input.takeoverId, input.lease] })
            return Response.json(result)
        }
        if (!target.agent.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
        const pending = await pendingTakeover(runtime, target)
        if (!pending || identity(target, pending) !== input.takeoverId || await byTakeover(target.db, sessionId, input.takeoverId)) throw new DesktopHttpError(409, 'This browser request is no longer waiting. Reload the conversation.')
        // Only the live viewer authority can reuse this exact lease. It may have expired
        // after a lost response or disconnected viewer while the durable row remained.
        const previousLease = existing && existing.launch_nonce === runtime.launchNonce && !Number(existing.released) ? String(existing.lease) : undefined
        const acquired = await desktopScreenTakeover(runtime, target.agent.id, AbortSignal.timeout(45_000), pending.url, previousLease)
        if (acquired.lease === previousLease) return Response.json(acquired, { headers: { 'x-takeover-id': input.takeoverId } })
        try {
            await target.db.execute({ sql: `INSERT INTO desktop_takeover_screens(takeover_id,agent_id,session_id,launch_nonce,lease,result_url,released,created_at) VALUES (?,?,?,?,?,NULL,0,?)
                ON CONFLICT(takeover_id) DO UPDATE SET launch_nonce=excluded.launch_nonce,lease=excluded.lease,result_url=NULL,released=0,created_at=excluded.created_at`, args: [input.takeoverId, target.agent.id, sessionId, runtime.launchNonce, acquired.lease, new Date().toISOString()] })
        } catch (error) { await desktopScreenFinishTakeover(runtime, target.agent.id, acquired.lease, AbortSignal.timeout(15_000)); throw error }
        return Response.json(acquired, { headers: { 'x-takeover-id': input.takeoverId } })
    })
}
