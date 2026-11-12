import 'server-only'
import type { Client, Row } from '@libsql/client'
import {
    desktopApprovalGuardSchema, desktopQuestionGuardSchema, documentScopeKey,
    findDesktopApproval, findDesktopQuestion, HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions,
    type DesktopDocumentReference, type DesktopQuestionGuard,
} from '@rerun/contracts'
import type { HistoryMessage } from '@/lib/chat/engine-history'
import type { EngineMessage } from '@/lib/engine/types'
import { redactHistoricalText } from '@/components/desktop/tool-presentations/redact'
import { desktopApprovalPayloadSchema } from '../approvals'
import { desktopQuestionPayloadSchema, type DesktopQuestionPayload } from '../questions'
import { questionDocumentIndex, questionDocumentTabUid } from '../question-documents'
import { desktopSavedChatReceiptSchema, type DesktopSavedChatDecision, type DesktopSavedChatReceipt } from '../saved-chat-decision'
import { desktopDocumentStore } from './document-attachments/store'

function json(value: unknown): unknown {
    try { return typeof value === 'string' ? JSON.parse(value) : null }
    catch { return null }
}

function sameSource(source: { sourceMessageId: string; toolCallId: string; fingerprint: string },
    guard: { sourceMessageId: string; toolCallId: string; fingerprint: string }) {
    return source.sourceMessageId === guard.sourceMessageId && source.toolCallId === guard.toolCallId &&
        source.fingerprint === guard.fingerprint
}

async function questionFiles(db: Client, agentId: string, sessionId: string, formId: string,
    payload: Extract<DesktopQuestionPayload, { action: 'answer' }>, references: readonly DesktopDocumentReference[]) {
    const groups: DesktopDocumentReference[][] = payload.answers.map(() => [])
    const documents = payload.documents
    if (!documents) return references.length ? null : groups
    const { scope, attachmentIds } = documents
    if (scope.agentId !== agentId || scope.sessionId !== sessionId || scope.tabUid !== questionDocumentTabUid(formId)
        || scope.questionId || documents.modelChoice || attachmentIds.length !== references.length ||
        new Set(attachmentIds).size !== attachmentIds.length) return null
    const scopeKey = documentScopeKey(scope)
    const store = desktopDocumentStore(db)
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

async function project(db: Client, agentId: string, sessionId: string, row: Row, message: HistoryMessage, turn: readonly EngineMessage[], guard: DesktopQuestionGuard): Promise<DesktopSavedChatDecision | null> {
    const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    if (!text || text !== row.answer_text) return null

    if (row.kind === 'question') {
        const source = findDesktopQuestion(turn)
        const payload = desktopQuestionPayloadSchema.safeParse(json(row.payload))
        if (!source || !payload.success || !sameSource(source, guard)) return null
        const references = message.metadata?.documents ?? []
        if (payload.data.action === 'cancel') return text === HITL_CANCELLED.question && !references.length
            ? { kind: 'question-dismissed' } : null
        const answers = payload.data.answers
        if (source.questions.length !== answers.length ||
            source.questions.some((item, index) => !item.multiple && answers[index].length > 1)) return null
        if (typeof row.form_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.form_id)) return null
        const groups = await questionFiles(db, agentId, sessionId, row.form_id, payload.data, references)
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
    const payload = desktopApprovalPayloadSchema.safeParse(json(row.payload))
    if (!source || !payload.success || !sameSource(source, guard) ||
        source.approvals.length !== payload.data.decisions.length || message.metadata?.documents?.length) return null
    const decisions = source.approvals.map((item, index) => ({ ...item, ...payload.data.decisions[index] }))
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
    if (!rows.length) return history
    const accepted = new Map<string, Row | null>()
    for (const row of rows) {
        const key = String(row.request_id)
        accepted.set(key, accepted.has(key) ? null : row)
    }
    const historyById = new Map(history.map(message => [message.id, message]))
    const admitted = new Map<string, DesktopSavedChatReceipt>()
    let remaining = RECEIPT_BUDGET
    let turnStart = 0
    // Scan in the transcript order to find the delivered request immediately preceding the answer.
    // The saved run binding selects the answer, rather than selecting a later copy of its text.
    for (const [index, message] of engine.entries()) {
        if (message.role !== 'user') continue
        const turn = engine.slice(turnStart, index)
        turnStart = index + 1
        const run = message.desktopRunId
        if (!run) continue
        const row = accepted.get(run)
        const rendered = historyById.get('engine-' + message.id)
        if (!row || rendered?.role !== 'user') continue
        const schema = row.kind === 'question' ? desktopQuestionGuardSchema : desktopApprovalGuardSchema
        const guard = schema.safeParse(json(row.guard))
        if (!guard.success) continue
        const value = await project(db, agentId, sessionId, row, rendered, turn, guard.data)
        const parsed = desktopSavedChatReceiptSchema.safeParse({
            sourceMessageId: 'engine-' + guard.data.sourceMessageId, sourceToolCallId: guard.data.toolCallId, decision: value,
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
