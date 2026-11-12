import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    desktopApprovalGuardSchema, desktopQuestionGuardSchema, documentScopeKey,
    findDesktopApproval, findDesktopQuestion, foremanBindingSchema, foremanDocumentScope, foremanQuestionGuardSchema,
    foremanRequestIdentityInput, HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions,
    type DesktopDocumentReference, type DesktopDocumentScope, type DesktopForemanQuestionGuard, type DesktopQuestionGuard,
} from '@rerun/contracts'
import type { HistoryMessage } from '@/lib/chat/engine-history'
import type { EngineMessage } from '@/lib/engine/types'
import { redactHistoricalText } from '@/components/desktop/tool-presentations/redact'
import { z } from 'zod'
import { desktopApprovalAnswerSchema, desktopApprovalPayloadSchema, type DesktopApprovalPayload } from '../approvals'
import { desktopQuestionAnswerSchema, desktopQuestionPayloadSchema, type DesktopQuestionPayload } from '../questions'
import { questionDocumentIndex, questionDocumentTabUid } from '../question-documents'
import { desktopSavedChatReceiptSchema, type DesktopSavedChatDecision, type DesktopSavedChatReceipt } from '../saved-chat-decision'
import { desktopDocumentStore } from './document-attachments/store'
import type { ForemanChat } from './foreman/chat-store'

function json(value: unknown): unknown {
    try { return typeof value === 'string' ? JSON.parse(value) : null }
    catch { return null }
}

type DecisionGuard = DesktopQuestionGuard | DesktopForemanQuestionGuard
type SavedDecision = { text: string; guard: DecisionGuard } & (
    | { kind: 'question'; scope: DesktopDocumentScope; payload: DesktopQuestionPayload }
    | { kind: 'approval'; payload: DesktopApprovalPayload }
)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function sameSource(source: DesktopQuestionGuard, guard: DecisionGuard, priorRunId?: string | null) {
    if (source.sourceMessageId !== guard.sourceMessageId || source.toolCallId !== guard.toolCallId) return false
    return 'fingerprint' in guard ? source.fingerprint === guard.fingerprint
        : guard.runId === priorRunId && guard.digest === sha256(source.fingerprint)
}

async function questionFiles(db: Client, scope: DesktopDocumentScope,
    payload: Extract<DesktopQuestionPayload, { action: 'answer' }>, references: readonly DesktopDocumentReference[]) {
    const groups: DesktopDocumentReference[][] = payload.answers.map(() => [])
    const documents = payload.documents
    if (!documents) return references.length ? null : groups
    const { attachmentIds } = documents
    const scopeKey = documentScopeKey(scope)
    if (documentScopeKey(documents.scope) !== scopeKey || documents.modelChoice ||
        attachmentIds.length !== references.length || new Set(attachmentIds).size !== attachmentIds.length) return null
    const store = desktopDocumentStore(db, scope.questionId ? 'foreman' : 'coworker')
    for (const [index, ref] of references.entries()) {
        if (attachmentIds[index] !== ref.attachmentId || documentScopeKey(ref.scope) !== scopeKey) return null
        const record = await store.read(scope, ref.attachmentId)
        if (!record || record.deletion) return null
        const attachment = record.attachment
        if (!attachment.admitted || attachment.sha256 !== ref.sha256 ||
            attachment.name !== ref.name || attachment.byteLength !== ref.byteLength ||
            attachment.mimeType !== ref.mimeType || attachment.kind !== ref.kind) return null
        const group = groups[questionDocumentIndex(attachment.position)]
        if (!group) return null
        group.push(ref)
    }
    return groups
}

async function project(db: Client, saved: SavedDecision, message: HistoryMessage, turn: readonly EngineMessage[], priorRunId?: string | null): Promise<DesktopSavedChatDecision | null> {
    const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    if (!text || text !== saved.text) return null

    const { guard } = saved
    if (saved.kind === 'question') {
        const source = findDesktopQuestion(turn)
        if (!source || !sameSource(source, guard, priorRunId)) return null
        const references = message.metadata?.documents ?? []
        if (saved.payload.action === 'cancel') return text === HITL_CANCELLED.question && !references.length
            ? { kind: 'question-dismissed' } : null
        const answers = saved.payload.answers
        if (source.questions.length !== answers.length ||
            source.questions.some((item, index) => !item.multiple && answers[index].length > 1)) return null
        const groups = await questionFiles(db, saved.scope, saved.payload, references)
        if (!groups) return null
        const original = source.questions.map((item, index) => ({
            question: item.question, answers: answers[index], attachments: groups[index].map(file => file.name),
        }))
        if (serializeAnswers(original, { attachmentsAreNames: true }) !== text) return null
        return { kind: 'answers', items: original.map((item, index) => ({
            question: item.question, answers: item.answers, fromOptions: source.questions[index].options.length > 0,
            attachmentIds: groups[index].map(file => file.attachmentId),
        })) }
    }

    const source = findDesktopApproval(turn)
    if (!source || !sameSource(source, guard, priorRunId) ||
        source.approvals.length !== saved.payload.decisions.length || message.metadata?.documents?.length) return null
    const decisions = source.approvals.map((item, index) => ({ ...item, ...saved.payload.decisions[index] }))
    if (serializeApprovalDecisions(decisions) !== text) return null
    return { kind: 'approvals', items: decisions.map(item => ({
        ...item, ...(item.detail && { detail: redactHistoricalText(item.detail, 7999) }),
    })) }
}

const RECEIPT_BUDGET = 256 * 1024

/** Only the exact admitted user row may display a receipt. Older histories without a binding,
 * unaccepted decisions and inconsistent provenance retain the ordinary conversation text. */
export async function withDesktopSavedDecisions(db: Client, agentId: string, sessionId: string, engine: readonly EngineMessage[], history: HistoryMessage[]): Promise<HistoryMessage[]> {
    if (!engine.some(message => message.role === 'user' && message.desktopRunId)) return history
    const { rows } = await db.execute({ sql: `
        SELECT 'question' AS kind, request_id, question_id AS form_id, question_guard AS guard, payload, answer_text, created_at
        FROM desktop_question_answers WHERE agent_id=? AND session_id=? AND accepted=1
        UNION ALL
        SELECT 'approval', request_id, approval_id, approval_guard, payload, answer_text, created_at
        FROM desktop_approval_answers WHERE agent_id=? AND session_id=? AND accepted=1
        ORDER BY created_at DESC, request_id DESC LIMIT 2048`,
        args: [agentId, sessionId, agentId, sessionId],
    })
    const accepted = new Map<string, SavedDecision | null>()
    for (const row of rows) {
        const key = String(row.request_id)
        const schema = row.kind === 'question' ? desktopQuestionGuardSchema : desktopApprovalGuardSchema
        const guard = schema.safeParse(json(row.guard))
        let saved: SavedDecision | null = null
        if (guard.success && typeof row.answer_text === 'string') {
            const text = row.answer_text
            if (row.kind === 'question' && typeof row.form_id === 'string' && /^[a-f0-9]{64}$/.test(row.form_id)) {
                const payload = desktopQuestionPayloadSchema.safeParse(json(row.payload))
                if (payload.success) saved = { kind: 'question', guard: guard.data, text, payload: payload.data,
                    scope: { agentId, sessionId, tabUid: questionDocumentTabUid(row.form_id) } }
            } else if (row.kind === 'approval') {
                const payload = desktopApprovalPayloadSchema.safeParse(json(row.payload))
                if (payload.success) saved = { kind: 'approval', guard: guard.data, text, payload: payload.data }
            }
        }
        accepted.set(key, accepted.has(key) ? null : saved)
    }
    return projectHistory(db, engine, history, accepted)
}

const savedForemanTurn = z.object({
    binding: foremanBindingSchema,
    sessionId: z.string(),
    text: z.string(),
    question: foremanQuestionGuardSchema.optional(),
    answerIntent: desktopQuestionAnswerSchema.optional(),
    approval: foremanQuestionGuardSchema.optional(),
    approvalIntent: desktopApprovalAnswerSchema.optional(),
})

export async function withForemanSavedDecisions(db: Client, owner: ForemanChat, engine: readonly EngineMessage[], history: HistoryMessage[]) {
    if (!engine.some(message => message.role === 'user' && message.foremanRunId)) return history
    const { chat, sessionId } = owner
    if (engine.some(message => message.sessionId !== sessionId)) return history
    const { rows } = await db.execute({ sql: `
        SELECT request_id, body FROM desktop_foreman_turns
        WHERE chat_id=? AND status IN ('admitted','finished') AND json_valid(body)
          AND (json_type(body, '$.answerIntent')='object' OR json_type(body, '$.approvalIntent')='object')
        ORDER BY created_at DESC, rowid DESC LIMIT 2048`, args: [chat.chatId] })
    const accepted = new Map<string, SavedDecision>()
    for (const row of rows) {
        const parsed = savedForemanTurn.safeParse(json(row.body))
        if (!parsed.success) continue
        const { binding, sessionId: savedSession, text, question, answerIntent, approval, approvalIntent } = parsed.data
        if (binding.runId !== row.request_id || binding.chatId !== chat.chatId ||
            binding.workspaceId !== chat.workspaceId || savedSession !== sessionId) continue
        if (question && answerIntent && !approval && !approvalIntent && answerIntent.requestId === binding.runId &&
            sha256(foremanRequestIdentityInput(chat, sessionId, question)) === answerIntent.questionId) {
            const payload = answerIntent.action === 'cancel' ? answerIntent : {
                ...answerIntent, answers: answerIntent.answers.map(group => group.map(answer => answer.trim()).filter(Boolean)),
            }
            accepted.set(binding.runId, { kind: 'question', guard: question, text, payload,
                scope: foremanDocumentScope(chat, sessionId, answerIntent.questionId) })
        } else if (approval && approvalIntent && !question && !answerIntent && approvalIntent.requestId === binding.runId &&
            sha256(foremanRequestIdentityInput(chat, sessionId, approval, 'approval')) === approvalIntent.approvalId) {
            accepted.set(binding.runId, { kind: 'approval', guard: approval, text, payload: approvalIntent })
        }
    }
    return projectHistory(db, engine, history, accepted, true)
}

async function projectHistory(db: Client, engine: readonly EngineMessage[], history: HistoryMessage[],
    accepted: ReadonlyMap<string, SavedDecision | null>, foreman = false) {
    if (!accepted.size) return history
    const historyById = new Map(history.map(message => [message.id, message]))
    const admitted = new Map<string, DesktopSavedChatReceipt>()
    let remaining = RECEIPT_BUDGET
    let turnStart = 0
    let previousRunId: string | null | undefined
    // Scan in the transcript order to find the delivered request immediately preceding the answer.
    // The saved run binding selects the answer, rather than selecting a later copy of its text.
    for (const [index, message] of engine.entries()) {
        if (message.role !== 'user') continue
        const turn = engine.slice(turnStart, index)
        turnStart = index + 1
        const run = foreman ? message.foremanRunId : message.desktopRunId
        const sourceRunId = previousRunId
        previousRunId = run
        const saved = run && accepted.get(run)
        const rendered = historyById.get('engine-' + message.id)
        if (!saved || rendered?.role !== 'user') continue
        const value = await project(db, saved, rendered, turn, sourceRunId)
        const parsed = desktopSavedChatReceiptSchema.safeParse({
            sourceMessageId: 'engine-' + saved.guard.sourceMessageId, sourceToolCallId: saved.guard.toolCallId, decision: value,
        })
        if (!parsed.success) continue
        remaining -= Buffer.byteLength(JSON.stringify(parsed.data))
        if (remaining < 0) break
        admitted.set(rendered.id, parsed.data)
    }
    return history.map(message => {
        const decision = admitted.get(message.id)
        return decision ? { ...message, metadata: { ...message.metadata, savedDecision: decision } } : message
    })
}
