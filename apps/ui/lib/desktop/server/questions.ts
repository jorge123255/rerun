import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { desktopQuestionGuardSchema, findDesktopQuestion, HITL_CANCELLED, serializeAnswers, type DesktopQuestion, type DesktopQuestionGuard } from '@rerun/contracts'
import { chat, EngineRequestError } from '@/lib/engine/client'
import { desktopQuestionPayloadSchema, type DesktopQuestionAnswer, type DesktopQuestionPayload, type DesktopQuestionView } from '../questions'
import { questionDocumentIndex, questionDocumentTabUid } from '../question-documents'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { disabledCoworkerMessage } from './coworker-enabled'
import { startDesktopChat } from './engine'
import { assertDesktopImageModel, resolveDesktopChatModel } from './chat-model'
import { withRosterWrite } from './roster-writes'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { resolveDesktopDocumentAdmission } from './document-attachments/binding'
import { desktopDocumentStore } from './document-attachments/store'
import {
    readDesktopHumanRequestMessages, readDesktopHumanRequestTarget, type DesktopHumanRequestTarget, type DesktopHumanRequestReadOptions,
} from './human-request-history'

type Target = DesktopHumanRequestTarget
type Receipt = { requestId: string; agentId: string; sessionId: string; questionId: string; guard: DesktopQuestionGuard; payload: DesktopQuestionPayload; text: string; accepted: boolean }
const answerLocks = globalThis as typeof globalThis & { desktopQuestionWrites?: Map<string, Promise<void>> }

function withAnswerWrite<T>(key: string, action: () => Promise<T>): Promise<T> {
    const locks = answerLocks.desktopQuestionWrites ??= new Map()
    const result = (locks.get(key) ?? Promise.resolve()).then(action)
    const settled = result.then(() => {}, () => {})
    locks.set(key, settled)
    void settled.then(() => { if (locks.get(key) === settled) locks.delete(key) })
    return result
}

function identity(target: Target, question: DesktopQuestion): string {
    return createHash('sha256').update(JSON.stringify([target.agent.id, target.session.id, question.sourceMessageId, question.toolCallId, question.fingerprint])).digest('hex')
}

async function pendingQuestion(runtime: DesktopRuntime, target: Target, options: DesktopHumanRequestReadOptions = {}): Promise<DesktopQuestion | null> {
    try {
        return findDesktopQuestion(await readDesktopHumanRequestMessages(runtime, target, options))
    } catch (cause) {
        if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        throw new DesktopHttpError(502, 'Could not read this coworker’s question. Try again.')
    }
}

function receiptOf(row: Row): Receipt {
    return { requestId: String(row.request_id), agentId: String(row.agent_id), sessionId: String(row.session_id), questionId: String(row.question_id),
        guard: desktopQuestionGuardSchema.parse(JSON.parse(String(row.question_guard))), payload: desktopQuestionPayloadSchema.parse(JSON.parse(String(row.payload))),
        text: String(row.answer_text), accepted: Number(row.accepted) === 1 }
}

async function byQuestion(db: Client, sessionId: string, questionId: string): Promise<Receipt | null> {
    const result = await db.execute({ sql: 'SELECT * FROM desktop_question_answers WHERE session_id = ? AND question_id = ?', args: [sessionId, questionId] })
    return result.rows[0] ? receiptOf(result.rows[0]) : null
}

async function byRequest(db: Client, requestId: string): Promise<Receipt | null> {
    const result = await db.execute({ sql: `SELECT a.* FROM desktop_question_requests r JOIN desktop_question_answers a ON a.request_id = r.answer_id WHERE r.request_id = ?`, args: [requestId] })
    return result.rows[0] ? receiptOf(result.rows[0]) : null
}

function payloadOf(input: DesktopQuestionAnswer): DesktopQuestionPayload {
    return input.action === 'cancel' ? { action: 'cancel' } : {
        action: 'answer', answers: input.answers.map(values => values.map(value => value.trim()).filter(Boolean)),
        ...(input.documents && { documents: input.documents }),
    }
}

function verifyReceipt(receipt: Receipt, target: Target, input: DesktopQuestionAnswer, payload: DesktopQuestionPayload) {
    if (receipt.agentId !== target.agent.id || receipt.sessionId !== target.session.id || receipt.questionId !== input.questionId) throw new DesktopHttpError(409, 'That answer request belongs to a different question or conversation.')
    if (JSON.stringify(receipt.payload) !== JSON.stringify(payload)) throw new DesktopHttpError(409, 'An answer is already saved for this question. Retry that answer instead of changing it.')
}

function answerText(question: DesktopQuestion, payload: DesktopQuestionPayload, files: string[][]): string {
    if (payload.action === 'cancel') return HITL_CANCELLED.question
    if (payload.answers.length !== question.questions.length) throw new DesktopHttpError(400, 'Answer or skip each question in this form.')
    if (question.questions.some((item, index) => !item.multiple && payload.answers[index].length > 1)) throw new DesktopHttpError(400, 'Choose one answer for each question that allows a single answer.')
    // Document references travel as engine context parts and render as their own file tiles.
    return serializeAnswers(question.questions.map((item, index) => ({
        question: item.question, answers: payload.answers[index], attachments: files[index],
    })), { attachmentsAreNames: true })
}

async function questionFileNames(runtime: DesktopRuntime, target: Target, question: DesktopQuestion, questionId: string, payload: DesktopQuestionPayload) {
    const files: string[][] = question.questions.map(() => [])
    if (payload.action === 'cancel' || !payload.documents) return files
    const documents = payload.documents
    const scope = documents.scope
    if (scope.agentId !== target.agent.id || scope.sessionId !== target.session.id ||
        scope.tabUid !== questionDocumentTabUid(questionId) || documents.modelChoice) {
        throw new DesktopHttpError(409, 'These files belong to another question or conversation.')
    }
    const store = desktopDocumentStore(target.db)
    let hasImage = false
    for (const id of documents.attachmentIds) {
        const record = await store.read(scope, id)
        const index = record && questionDocumentIndex(record.attachment.position)
        if (!record || index === null || !files[index]) throw new DesktopHttpError(409, 'A file is no longer assigned to this question.')
        files[index].push(record.attachment.name)
        hasImage ||= record.attachment.kind === 'image'
    }
    if (hasImage) {
        const { connectionId } = await resolveDesktopChatModel(runtime, target.agent, target.session)
        await assertDesktopImageModel(runtime, connectionId)
    }
    await resolveDesktopDocumentAdmission(runtime, target.agent.id, documents, AbortSignal.timeout(20_000))
    return files
}

// Read-only by design: history filters can use this same resolver without creating a receipt,
// starting a turn, or inventing an unfinished run when the original question turn is already done.
export async function readDesktopQuestion(runtime: DesktopRuntime, sessionId: string, options: DesktopHumanRequestReadOptions = {}): Promise<DesktopQuestionView> {
    const target = await readDesktopHumanRequestTarget(runtime, sessionId)
    const pending = await pendingQuestion(runtime, target, options)
    if (!pending) return { question: null }
    const id = identity(target, pending)
    const receipt = await byQuestion(target.db, sessionId, id)
    if (receipt?.accepted) return { question: null }
    return { question: { id, messageId: pending.sourceMessageId, toolCallId: pending.toolCallId, questions: pending.questions,
        ...(pending.requestedAt ? { requestedAt: pending.requestedAt } : {}),
        ...(receipt && { attempt: { ...receipt.payload, requestId: receipt.requestId } }),
    } }
}

export async function requireDesktopPendingQuestion(runtime: DesktopRuntime, sessionId: string, questionId: string, signal: AbortSignal, allowReserved = false) {
    signal.throwIfAborted()
    const target = await readDesktopHumanRequestTarget(runtime, sessionId)
    const unavailable = () => new DesktopHttpError(409, 'This question is no longer waiting for an answer.')
    if (!target.agent.enabled) throw unavailable()
    const pending = await pendingQuestion(runtime, target, { signal })
    if (!pending || identity(target, pending) !== questionId) throw unavailable()
    const receipt = await byQuestion(target.db, sessionId, questionId)
    if (receipt && (receipt.accepted || !allowReserved)) throw unavailable()
    const current = await readDesktopHumanRequestTarget(runtime, sessionId)
    signal.throwIfAborted()
    if (!current.agent.enabled || current.agent.id !== target.agent.id || current.agent.engineAgentId !== target.agent.engineAgentId ||
        current.session.engineSessionId !== target.session.engineSessionId) throw unavailable()
    return current
}

function identified(response: Response, receipt: Receipt) {
    response.headers.set('x-question-id', receipt.questionId)
    return response
}

function acceptedResponse(receipt: Receipt) {
    return identified(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': receipt.sessionId, 'x-run-id': receipt.requestId } }), receipt)
}

async function markAccepted(db: Client, receipt: Receipt) {
    await db.execute({ sql: 'UPDATE desktop_question_answers SET accepted = 1 WHERE request_id = ? AND session_id = ? AND question_id = ?', args: [receipt.requestId, receipt.sessionId, receipt.questionId] })
    const documents = receipt.payload.action === 'answer' ? receipt.payload.documents : undefined
    // Admission retains the exact bytes for history. Consuming removes the files from the
    // selection only, and must not turn an acknowledged answer into a failed one.
    if (documents) await desktopDocumentStore(db).consume(documents.scope, documents.admissionId).catch(() => {})
}

// Probe before testing whether the question is still pending. Its accepted user turn is exactly
// what makes it stop being pending; a lost response must not turn that success into a stale error.
async function reconcile(runtime: DesktopRuntime, target: Target, receipt: Receipt): Promise<Response | null> {
    if (receipt.accepted) {
        await markAccepted(target.db, receipt)
        return acceptedResponse(receipt)
    }
    let response: Response
    try {
        const documents = receipt.payload.action === 'answer' ? receipt.payload.documents : undefined
        response = await chat(engineOf(runtime), target.agent.engineAgentId, { sessionId: target.session.engineSessionId, message: receipt.text,
            desktopQueuedTurn: { runId: receipt.requestId, replayOnly: true, question: receipt.guard, ...(documents && { documents }) }, source: 'dashboard' })
    } catch { throw new DesktopHttpError(502, 'Could not check whether this answer was sent. Retry the same answer.') }
    if (response.status === 404 && (await response.clone().json().catch(() => ({}))).code === 'queued_turn_not_found') return null
    if (response.status === 403) throw new DesktopHttpError(403, disabledCoworkerMessage)
    if (!response.ok || response.headers.get('x-session-id') !== target.session.engineSessionId || response.headers.get('x-run-id') !== receipt.requestId) throw new DesktopHttpError(502, 'Could not confirm this answer. Retry the same answer.')
    if (response.status !== 204 && !response.body) throw new DesktopHttpError(502, 'Could not read this answer’s reply. Retry the same answer.')
    await markAccepted(target.db, receipt)
    const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'text/event-stream',
        'x-vercel-ai-ui-message-stream': response.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1', 'x-session-id': target.session.id, 'x-run-id': receipt.requestId })
    return identified(new Response(response.status === 204 ? 'data: [DONE]\n\n' : response.body, { status: 200, headers }), receipt)
}

async function reserve(target: Target, input: DesktopQuestionAnswer, payload: DesktopQuestionPayload, pending?: DesktopQuestion, text?: string): Promise<Receipt> {
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(target.db, target.agent.id)
        const existing = await byRequest(target.db, input.requestId) ?? await byQuestion(target.db, target.session.id, input.questionId)
        if (existing) {
            verifyReceipt(existing, target, input, payload)
            await target.db.execute({ sql: 'INSERT INTO desktop_question_requests (request_id, answer_id) VALUES (?,?) ON CONFLICT(request_id) DO NOTHING', args: [input.requestId, existing.requestId] })
            return existing
        }
        if (!pending || text === undefined || identity(target, pending) !== input.questionId) throw new DesktopHttpError(409, 'This question is no longer waiting for an answer. Reload the conversation.')
        const guard = { sourceMessageId: pending.sourceMessageId, toolCallId: pending.toolCallId, fingerprint: pending.fingerprint }
        await target.db.batch([
            { sql: 'INSERT INTO desktop_question_answers (request_id,agent_id,session_id,question_id,question_guard,payload,answer_text,created_at) VALUES (?,?,?,?,?,?,?,?)', args: [input.requestId, target.agent.id, target.session.id, input.questionId, JSON.stringify(guard), JSON.stringify(payload), text, new Date().toISOString()] },
            { sql: 'INSERT INTO desktop_question_requests (request_id,answer_id) VALUES (?,?)', args: [input.requestId, input.requestId] },
        ], 'write')
        return { requestId: input.requestId, agentId: target.agent.id, sessionId: target.session.id, questionId: input.questionId, guard, payload, text, accepted: false }
    })
}

export function answerDesktopQuestion(runtime: DesktopRuntime, sessionId: string, input: DesktopQuestionAnswer): Promise<Response> {
    return withAnswerWrite(runtime.dataRoot + '\0' + sessionId, async () => {
        const target = await readDesktopHumanRequestTarget(runtime, sessionId)
        const payload = payloadOf(input)
        const known = await byRequest(target.db, input.requestId) ?? await byQuestion(target.db, sessionId, input.questionId)
        let receipt: Receipt
        if (known) {
            verifyReceipt(known, target, input, payload)
            receipt = await reserve(target, input, payload)
            const replay = await reconcile(runtime, target, receipt)
            if (replay) return replay
        } else {
            const pending = await pendingQuestion(runtime, target)
            if (!pending || identity(target, pending) !== input.questionId) throw new DesktopHttpError(409, 'This question is no longer waiting for an answer. Reload the conversation.')
            if (!target.agent.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
            const text = answerText(pending, payload, await questionFileNames(runtime, target, pending, input.questionId, payload))
            receipt = await reserve(target, input, payload, pending, text)
        }
        if (!target.agent.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
        // The engine repeats the latest-question check while holding its session claim, closing
        // the race with an ordinary chat send after this UI process read the saved transcript.
        const documents = receipt.payload.action === 'answer' ? receipt.payload.documents : undefined
        const result = await startDesktopChat(runtime, { agentId: target.agent.id, sessionId, text: receipt.text, requestId: receipt.requestId,
            question: receipt.guard, ...(documents && { documents, questionDocumentId: receipt.questionId }) })
        await markAccepted(target.db, receipt)
        return identified(result.response, receipt)
    })
}
