import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    findDesktopApproval, findDesktopQuestion, foremanDocumentScope, foremanRequestIdentityInput, HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions,
    type DesktopDocumentReference, type DesktopForemanQuestionGuard,
} from '@rerun/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineMessage } from '@/lib/engine/types'
import { publicDesktopHistory, transformEngineMessages } from '@/lib/chat/engine-history'
import { questionDocumentTabUid } from '../question-documents'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, createDesktopSession } from './store'
import { desktopDocumentStore } from './document-attachments/store'
import { ensureForemanChat } from './foreman/chat-store'
import { withDesktopSavedDecisions, withForemanSavedDecisions } from './saved-chat-decisions'

const now = '2026-11-10T12:00:00.000Z'
let root: string
let db: Awaited<ReturnType<typeof openDesktopDatabase>>
let agentId: string
let sessionId: string
let siblingId: string
const engineSession = 'fixture-engine-chat'

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-saved-decisions-'))
    db = await openDesktopDatabase(root)
    const agent = await createDesktopAgent(db, { engineAgentId: 'engine-coworker', name: 'QA coworker' })
    agentId = agent.id
    sessionId = (await createDesktopSession(db, { agentId, engineSessionId: engineSession, title: 'First' })).id
    siblingId = (await createDesktopSession(db, { agentId, engineSessionId: 'engine-sibling', title: 'Sibling' })).id
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    await rm(root, { recursive: true, force: true })
})

function message(id: string, role: EngineMessage['role'], content: unknown, run?: string): EngineMessage {
    return { id, role, sessionId: engineSession, createdAt: now, contentJson: JSON.stringify(content), toolCallsJson: null, ...(run && { desktopRunId: run }) }
}
function request(toolName: string, toolCallId: string, input: unknown) {
    return [
        message(toolCallId + '-source', 'assistant', [{ type: 'tool-call', toolName, toolCallId, input }]),
        message(toolCallId + '-delivery', 'tool', [{ type: 'tool-result', toolName, toolCallId, output: { type: 'json', value: { status: 'delivered' } } }]),
    ]
}
const sourceOf = (source: { sourceMessageId: string; toolCallId: string; fingerprint: string }) =>
    ({ sourceMessageId: source.sourceMessageId, toolCallId: source.toolCallId, fingerprint: source.fingerprint })

function receipt(kind: 'question' | 'approval', formId: string, runId: string, guard: unknown, text: string, payload: unknown,
    target = sessionId, accepted = 1) {
    const [table, id, column] = kind === 'question'
        ? ['desktop_question_answers', 'question_id', 'question_guard'] : ['desktop_approval_answers', 'approval_id', 'approval_guard']
    return db.execute({ sql: `INSERT INTO ${table}(request_id,agent_id,session_id,${id},${column},payload,answer_text,created_at,accepted) VALUES(?,?,?,?,?,?,?,?,?)`,
        args: [runId, agentId, target, formId, JSON.stringify(guard), JSON.stringify(payload), text, now, accepted] })
}
const view = (engine: EngineMessage[], target = sessionId) =>
    withDesktopSavedDecisions(db, agentId, target, engine, publicDesktopHistory(transformEngineMessages(engine, { desktopSummaries: true })))

describe('saved coworker decision receipts', () => {
    it('binds answers, dismissals and indexed approval decisions to their admitted rows', async () => {
        const q = request('ask_user', 'choose-color', { questions: [
            { question: 'Which color?', options: ['Blue', 'Red'] },
            { question: 'A note?' },
        ] })
        const approval = request('request_approval', 'review-checklist', { approvals: [
            { action: 'Review the report', detail: 'Draft only' },
            { action: 'Keep the old checklist', detail: 'Authorization: Bearer QA-fixture-do-not-show' },
        ] })
        const dismissed = request('ask_user', 'dismiss', { question: 'Would you like a recap?' })
        const answerRun = randomUUID(), approvalRun = randomUUID(), dismissedRun = randomUUID()
        const answers = [['Blue'], []]
        const choices = [{ decision: 'approved' }, { decision: 'declined', note: 'Review it later' }] as const
        const qSource = findDesktopQuestion(q)!
        const approvalSource = findDesktopApproval(approval)!
        const qText = serializeAnswers(qSource.questions.map((item, i) => ({ question: item.question, answers: answers[i] })), { attachmentsAreNames: true })
        const approvalText = serializeApprovalDecisions(approvalSource.approvals.map((item, i) => ({ ...item, ...choices[i] })))
        await receipt('question', 'a'.repeat(64), answerRun, sourceOf(qSource), qText, { action: 'answer', answers })
        await receipt('approval', 'b'.repeat(64), approvalRun, sourceOf(approvalSource), approvalText, { decisions: choices })
        await receipt('question', 'c'.repeat(64), dismissedRun, sourceOf(findDesktopQuestion(dismissed)!), HITL_CANCELLED.question, { action: 'cancel' })
        const rows = [...q, message('answer', 'user', qText, answerRun), ...approval,
            message('decisions', 'user', approvalText, approvalRun), ...dismissed,
            message('skip', 'user', HITL_CANCELLED.question, dismissedRun), message('ordinary', 'user', approvalText, randomUUID())]
        const history = await view(rows)
        const saved = Object.fromEntries(history.filter(item => item.metadata?.savedDecision).map(item => [item.id, item.metadata?.savedDecision?.decision]))
        expect(saved).toEqual({
            'engine-answer': { kind: 'answers', items: [
                { question: 'Which color?', answers: ['Blue'], fromOptions: true, attachmentIds: [] },
                { question: 'A note?', answers: [], fromOptions: false, attachmentIds: [] },
            ] },
            'engine-decisions': { kind: 'approvals', items: [
                { action: 'Review the report', detail: 'Draft only', decision: 'approved' },
                { action: 'Keep the old checklist', detail: 'Authorization: [redacted]', decision: 'declined', note: 'Review it later' },
            ] },
            'engine-skip': { kind: 'question-dismissed' },
        })
        expect(history.find(item => item.id === 'engine-decisions')?.metadata?.savedDecision).toMatchObject({
            sourceMessageId: 'engine-review-checklist-source', sourceToolCallId: 'review-checklist',
        })
        expect(JSON.stringify(history)).not.toContain(approvalRun)
        expect(JSON.stringify(saved)).not.toContain('QA-fixture-do-not-show')
        expect((await view(rows, siblingId)).some(item => item.metadata?.savedDecision)).toBe(false)
    })

    it('leaves reserved, unrelated and ambiguous decisions as ordinary transcript text', async () => {
        const rows = request('ask_user', 'which', { question: 'Which color?' })
        const guard = sourceOf(findDesktopQuestion(rows)!)
        const text = serializeAnswers([{ question: 'Which color?', answers: ['Blue'] }], { attachmentsAreNames: true })
        const runId = randomUUID()
        const body = { action: 'answer', answers: [['Blue']] }
        const current = [...rows, message('reply', 'user', text, runId)]
        await receipt('question', 'a'.repeat(64), runId, guard, text, body, sessionId, 0)
        const projected = async (engine: EngineMessage[]) => (await view(engine)).at(-1)?.metadata?.savedDecision
        expect(await projected(current)).toBeUndefined()
        await db.execute({ sql: 'UPDATE desktop_question_answers SET accepted=1 WHERE request_id=?', args: [runId] })
        expect(await projected([...rows, message('older', 'user', text)])).toBeUndefined()
        expect(await projected([...rows, message('extra', 'user', 'Something else'), current.at(-1)!])).toBeUndefined()
        expect(await projected([...rows, message('reply', 'user', 'Different answer', runId)])).toBeUndefined()
        await receipt('approval', 'b'.repeat(64), runId, guard, text, { decisions: [{ decision: 'approved' }] })
        expect(await projected(current)).toBeUndefined()
    })

    it('uses the admitted attachment identity and position even when two files have the same name', async () => {
        const prompts = [{ question: 'First file?' }, { question: 'Second file?' }]
        const rows = request('ask_user', 'files', { questions: prompts })
        const formId = 'd'.repeat(64)
        const scope = { agentId, tabUid: questionDocumentTabUid(formId), sessionId }
        const store = desktopDocumentStore(db)
        const documents: DesktopDocumentReference[] = []
        for (const [index, bytes] of ['fixture first', 'fixture second'].entries()) {
            const ref = { attachmentId: randomUUID(), scope, name: 'notes.txt', mimeType: 'text/plain', kind: 'text' as const,
                sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: Buffer.byteLength(bytes) }
            await store.reserve({ fingerprint: ref.sha256, deletion: false, attachment: {
                ...ref, conversion: { mode: 'plain-text', state: 'ready', text: bytes }, admitted: false, selected: true,
                position: index * 1000, uploaded: false, revision: randomUUID(), createdAt: now, updatedAt: now,
            } })
            await db.execute({ sql: 'UPDATE desktop_document_attachments SET admitted=1, selected=0 WHERE attachment_id=?', args: [ref.attachmentId] })
            documents.push(ref)
        }
        const answers = [[], []]
        const text = serializeAnswers(prompts.map(item => ({ question: item.question, answers: [], attachments: ['notes.txt'] })), { attachmentsAreNames: true })
        const run = randomUUID()
        await receipt('question', formId, run, sourceOf(findDesktopQuestion(rows)!), text, { action: 'answer', answers,
            documents: { scope, admissionId: randomUUID(), attachmentIds: documents.map(file => file.attachmentId) } })
        const context = (ref: DesktopDocumentReference) => ({ type: 'text', text: 'attachment context', providerOptions: { rerun: { context: true, desktopDocument: ref } } })
        const read = async (refs: DesktopDocumentReference[]) => (await view([...rows,
            message('user-files', 'user', [{ type: 'text', text }, ...refs.map(context)], run)])).at(-1)?.metadata?.savedDecision?.decision
        expect(await read(documents)).toMatchObject({ kind: 'answers', items: [
            { attachmentIds: [documents[0].attachmentId] }, { attachmentIds: [documents[1].attachmentId] },
        ] })
        expect(await read([documents[1], documents[0]])).toBeUndefined()
        expect(await read([documents[0], { ...documents[1], sha256: 'a'.repeat(64) }])).toBeUndefined()
    })
})

describe('saved Chief of Staff decision receipts', () => {
    const binding = { connectionId: 'fixture-model', model: 'qa-local' }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const foremanGuard = (source: { sourceMessageId: string; toolCallId: string; fingerprint: string }, runId: string): DesktopForemanQuestionGuard =>
        ({ runId, sourceMessageId: source.sourceMessageId, toolCallId: source.toolCallId, digest: hash(source.fingerprint) })

    it('binds mixed approvals to the admitted turn, surviving reopen and repeated provider call IDs', async () => {
        const owner = await ensureForemanChat(db, '1')
        const first = request('request_approval', 'reused-id', { approvals: [{ action: 'Review the report' }, { action: 'Rename it' }] })
        const second = request('request_approval', 'reused-id', { approvals: [{ action: 'Review a different draft' }] })
            .map(row => ({ ...row, id: row.id + '-later' }))
        const requestRun = randomUUID(), answerRun = randomUUID()
        const source = findDesktopApproval(first)!
        const guard = foremanGuard(source, requestRun)
        const decisions = [{ decision: 'approved' }, { decision: 'declined', note: 'Keep the name.' }] as const
        const text = serializeApprovalDecisions(source.approvals.map((item, index) => ({ ...item, ...decisions[index] })))
        const body = { binding: { ...owner.chat, runId: answerRun, model: binding }, sessionId: owner.sessionId, text, approval: guard,
            approvalIntent: { requestId: answerRun, approvalId: hash(foremanRequestIdentityInput(owner.chat, owner.sessionId, guard, 'approval')), decisions } }
        await db.execute({ sql: 'INSERT INTO desktop_foreman_turns VALUES(?,?,?,?,?,?,NULL)',
            args: [answerRun, owner.chat.chatId, 'fixture', JSON.stringify(body), 'pending', now] })
        const prompt = { ...message('prompt', 'user', 'Propose two actions'), foremanRunId: requestRun }
        const answer = { ...message('decision', 'user', text), foremanRunId: answerRun }
        const read = async (rows: EngineMessage[], target = owner) => {
            const engine = rows.map(row => ({ ...row, sessionId: owner.sessionId }))
            const history = await withForemanSavedDecisions(db, target, engine, publicDesktopHistory(transformEngineMessages(engine)))
            return history.flatMap(row => row.metadata?.savedDecision ? [row.metadata.savedDecision] : [])
        }
        const rows = [prompt, ...first, answer, ...second, message('copied', 'user', text, randomUUID())]
        expect(await read(rows)).toEqual([])
        await db.execute({ sql: "UPDATE desktop_foreman_turns SET status='admitted' WHERE request_id=?", args: [answerRun] })
        await closeDesktopDatabase(root)
        db = await openDesktopDatabase(root)
        const cards = await read(rows)
        expect(cards).toEqual([{ sourceMessageId: 'engine-reused-id-source', sourceToolCallId: 'reused-id', decision: { kind: 'approvals', items: [
            { action: 'Review the report', decision: 'approved' },
            { action: 'Rename it', decision: 'declined', note: 'Keep the name.' },
        ] } }])
        expect(JSON.stringify(cards)).not.toContain(guard.digest)
        expect(await read(rows, { ...owner, chat: { ...owner.chat, workspaceId: '2' } })).toEqual([])
        expect(await read([{ ...prompt, foremanRunId: randomUUID() }, ...first, answer])).toEqual([])
        expect(await read([prompt, ...first, { ...answer, foremanRunId: null }])).toEqual([])
        expect(await read([prompt, first[0], answer])).toEqual([])
        expect(await read([prompt, ...first, message('other', 'user', 'Another message'), answer])).toEqual([])
        // Even a matching form hash is insufficient if the stored source fingerprint changed.
        const changed = { ...guard, digest: 'a'.repeat(64) }
        await db.execute({ sql: 'UPDATE desktop_foreman_turns SET body=? WHERE request_id=?', args: [JSON.stringify({
            ...body, approval: changed, approvalIntent: { ...body.approvalIntent,
                approvalId: hash(foremanRequestIdentityInput(owner.chat, owner.sessionId, changed, 'approval')) },
        }), answerRun] })
        expect(await read(rows)).toEqual([])
    })

    it('groups admitted question files from the Chief of Staff store and recognizes a saved dismissal', async () => {
        const owner = await ensureForemanChat(db, '1')
        const prompts = [{ question: 'First attachment?' }, { question: 'Second attachment?' }]
        const first = request('ask_user', 'file-question', { questions: prompts })
        const second = request('ask_user', 'optional-question', { question: 'Any more detail?' })
        const run = randomUUID(), answerRun = randomUUID(), dismissedRun = randomUUID()
        const guard = foremanGuard(findDesktopQuestion(first)!, run)
        const questionId = hash(foremanRequestIdentityInput(owner.chat, owner.sessionId, guard))
        const scope = foremanDocumentScope(owner.chat, owner.sessionId, questionId)
        const store = desktopDocumentStore(db, 'foreman')
        const documents: DesktopDocumentReference[] = []
        for (const [index, bytes] of ['first file', 'second file'].entries()) {
            const ref = { attachmentId: randomUUID(), scope, name: 'notes.txt', mimeType: 'text/plain', kind: 'text' as const,
                sha256: hash(bytes), byteLength: Buffer.byteLength(bytes) }
            await store.reserve({ fingerprint: ref.sha256, deletion: false, attachment: {
                ...ref, conversion: { mode: 'plain-text', state: 'ready', text: bytes }, admitted: false, selected: true,
                position: index * 1000, uploaded: false, revision: randomUUID(), createdAt: now, updatedAt: now,
            } })
            await db.execute({ sql: 'UPDATE desktop_foreman_document_attachments SET admitted=1 WHERE attachment_id=?', args: [ref.attachmentId] })
            documents.push(ref)
        }
        const text = serializeAnswers(prompts.map(item => ({ question: item.question, answers: [], attachments: ['notes.txt'] })), { attachmentsAreNames: true })
        const secondGuard = foremanGuard(findDesktopQuestion(second)!, answerRun)
        const record = (runId: string, source: DesktopForemanQuestionGuard, text: string, intent: object) => db.execute({
            sql: 'INSERT INTO desktop_foreman_turns VALUES(?,?,?,?,?,?,NULL)',
            args: [runId, owner.chat.chatId, 'fixture', JSON.stringify({ binding: { ...owner.chat, runId, model: binding },
                sessionId: owner.sessionId, text, question: source, answerIntent: { ...intent, requestId: runId,
                    questionId: hash(foremanRequestIdentityInput(owner.chat, owner.sessionId, source)) } }), 'finished', now],
        })
        await record(answerRun, guard, text, { action: 'answer', answers: [[], []], documents: {
            scope, admissionId: randomUUID(), attachmentIds: documents.map(ref => ref.attachmentId),
        } })
        await record(dismissedRun, secondGuard, HITL_CANCELLED.question, { action: 'cancel' })
        const context = (ref: DesktopDocumentReference) => ({ type: 'text', text: 'attachment context', providerOptions: { rerun: { context: true, desktopDocument: ref } } })
        const read = async (refs: DesktopDocumentReference[]) => {
            const engine = [{ ...message('initial', 'user', 'Ask about files'), foremanRunId: run }, ...first,
                { ...message('answer', 'user', [{ type: 'text', text }, ...refs.map(context)]), foremanRunId: answerRun }, ...second,
                { ...message('dismiss', 'user', HITL_CANCELLED.question), foremanRunId: dismissedRun },
            ].map(row => ({ ...row, sessionId: owner.sessionId }))
            return withForemanSavedDecisions(db, owner, engine, publicDesktopHistory(transformEngineMessages(engine)))
        }
        const result = await read(documents)
        expect(result.find(row => row.id === 'engine-answer')?.metadata?.savedDecision?.decision).toMatchObject({ kind: 'answers', items: [
            { attachmentIds: [documents[0].attachmentId] }, { attachmentIds: [documents[1].attachmentId] },
        ] })
        expect(result.at(-1)?.metadata?.savedDecision?.decision).toEqual({ kind: 'question-dismissed' })
        expect((await read([...documents].reverse())).find(row => row.id === 'engine-answer')?.metadata?.savedDecision).toBeUndefined()
    })
})
