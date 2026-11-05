import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { findDesktopQuestion, HITL_CANCELLED, serializeAnswers, type Message } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET, POST } from './route'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent, a: DesktopSession, b: DesktopSession
let rejectBeforeAccept: boolean, foreignHistory: boolean, historyReads: number, modelReads: number
const histories = new Map<string, Message[]>(), receipts = new Map<string, string>(), dispatches: Record<string, unknown>[] = []
const questions = [
    { question: 'Which name?', options: [] },
    { question: 'Choose a color', options: ['Blue', 'Green'] },
    { question: 'Pick channels', options: ['Email', 'Chat'], multiple: true },
    { question: 'Anything else?', options: [] },
]
const values = [['  Rerun Mac  '], ['Blue'], ['Email', 'Chat', 'A custom channel'], []]

function message(sessionId: string, role: Message['role'], content: unknown, id = crypto.randomUUID()): Message {
    return { id, sessionId, role, contentJson: JSON.stringify(content), toolCallsJson: null, sourcesJson: null, createdAt: new Date().toISOString(), authorId: null }
}
function questionRows(sessionId: string, name = 'ask_user', callId = 'call-1', input: unknown = { questions }) {
    return [message(sessionId, 'assistant', [{ type: 'text', text: 'A few questions before I continue.' }, { type: 'tool-call', toolName: name, toolCallId: callId, input }]),
        message(sessionId, 'tool', [{ type: 'tool-result', toolName: name, toolCallId: callId, output: { type: 'json', value: { status: 'delivered' } } }])]
}
function request(sessionId: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const origin = runtime.app.origin
    return new Request(`${origin}/api/desktop/sessions/${sessionId}/questions`, { method, headers: { host: new URL(origin).host, origin,
        cookie: 'rerun-desktop-session=' + runtime.app.sessionToken, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const get = (sessionId = a.id) => GET(request(sessionId), { params: Promise.resolve({ sessionId }) })
const post = (body: unknown, sessionId = a.id, headers?: Record<string, string>) => POST(request(sessionId, 'POST', body, headers), { params: Promise.resolve({ sessionId }) })
const pending = async (sessionId = a.id) => (await (await get(sessionId)).json()).question as DesktopPendingQuestion
const answer = (question: DesktopPendingQuestion, answers = values): DesktopQuestionAnswer => ({ questionId: question.id, requestId: crypto.randomUUID(), action: 'answer', answers })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-question-api-'))
    histories.clear(); receipts.clear(); dispatches.length = 0; rejectBeforeAccept = false; foreignHistory = false; historyReads = 0; modelReads = 0
    server = createServer(async (req, res) => {
        let raw = ''; for await (const part of req) raw += part
        const body = raw ? JSON.parse(raw) : null
        const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
        if (req.method === 'GET' && /^\/agents\/(engine-alice|engine-bob)\/setup$/.test(req.url ?? '')) return reply(200, {
            required: false, prompt: '', completedAt: null, sessionId: null, pending: false, revision: 'fixture-setup',
        })
        if (req.method === 'GET' && req.url === '/connections') {
            modelReads++
            return reply(200, { connections: [{ id: 'provider', name: 'Fixture', provider: 'codex', models: ['workspace-model', 'chat-model'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }], default: { connectionId: 'provider', model: 'workspace-model' } })
        }
        const agentMatch = req.url?.match(/^\/agents\/(engine-alice|engine-bob)$/)
        if (req.method === 'GET' && agentMatch) return reply(200, { id: agentMatch[1], config: { name: agentMatch[1], enabled: true }, soul: '' })
        const history = req.url?.match(/^\/agents\/(engine-alice|engine-bob)\/sessions\/([^/]+)\/messages$/)
        if (req.method === 'GET' && history) {
            historyReads++
            if ((history[1] === 'engine-alice' && history[2] !== 'engine-a') || (history[1] === 'engine-bob' && history[2] !== 'engine-b')) return reply(404, { error: 'Missing' })
            return reply(200, { messages: foreignHistory ? histories.get('engine-b') : histories.get(history[2]) ?? [] })
        }
        const chat = req.url?.match(/^\/agents\/(engine-alice|engine-bob)\/chat$/)
        if (req.method === 'POST' && chat) {
            const turn = body.desktopQueuedTurn
            const identity = JSON.stringify([chat[1], body.sessionId, body.message, turn?.question])
            if (receipts.has(turn?.runId)) {
                if (receipts.get(turn.runId) !== identity) return reply(409, { error: 'Different queued message' })
                return res.writeHead(204, { 'x-session-id': body.sessionId, 'x-run-id': turn.runId }).end()
            }
            if (turn?.replayOnly) return reply(404, { code: 'queued_turn_not_found' })
            dispatches.push(body)
            if (rejectBeforeAccept) return reply(503, { error: 'Provider unavailable' })
            const question = findDesktopQuestion(histories.get(body.sessionId) ?? [])
            if (!question || question.sourceMessageId !== turn?.question?.sourceMessageId || question.toolCallId !== turn.question.toolCallId || question.fingerprint !== turn.question.fingerprint) return reply(409, { error: 'Question is stale' })
            receipts.set(turn.runId, identity)
            histories.get(body.sessionId)!.push(message(body.sessionId, 'user', [{ type: 'text', text: body.message }]))
            return res.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId, 'x-run-id': turn.runId }).end('data: [DONE]\n\n')
        }
        reply(404, { error: 'Missing fixture route' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: 'question-launch', buildId: 'question-api', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3192', sessionToken: 'q'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' }); bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    a = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'engine-a', title: 'Alice chat', model: { connectionId: 'provider', model: 'chat-model' } })
    b = await createDesktopSession(db, { agentId: bob.id, engineSessionId: 'engine-b', title: 'Bob chat' })
    histories.set('engine-a', questionRows('engine-a')); histories.set('engine-b', questionRows('engine-b'))
})
afterEach(async () => {
    await closeDesktopDatabase(root); process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('GET returns only a delivered, owned saved question and is read-only', async () => {
    const question = await pending()
    expect(question.questions).toEqual(questions.map(item => ({ ...item, multiple: item.multiple === true })))
    expect(question.id).toMatch(/^[a-f0-9]{64}$/)
    expect(question.id).not.toBe((await pending(b.id)).id)
    const db = await openDesktopDatabase(root)
    expect((await db.execute('SELECT * FROM desktop_question_answers')).rows).toHaveLength(0)
    expect(dispatches).toHaveLength(0); expect(modelReads).toBe(0)
    histories.set('engine-a', questionRows('engine-a', 'request_approval'))
    expect(await pending()).toBeNull()
    histories.set('engine-a', questionRows('engine-a'))
    histories.get('engine-a')![1].contentJson = JSON.stringify([{ type: 'tool-result', toolCallId: 'call-1', output: { type: 'error-text', value: 'Rejected' } }])
    expect(await pending()).toBeNull()
    foreignHistory = true
    expect((await get()).status).toBe(502)
})

test('auth, strict input and opaque question identity reject forged and foreign answers before any send', async () => {
    const question = await pending(), body = answer(question)
    expect((await post(body, a.id, { cookie: '' })).status).toBe(401)
    expect((await post(body, a.id, { origin: 'https://example.com' })).status).toBe(403)
    expect((await post({ ...body, agentId: bob.id })).status).toBe(400)
    expect((await post({ ...body, attachmentPath: 'secret.md' })).status).toBe(400)
    expect((await post({ ...body, answers: [{ question: 'Forged text', answers: ['yes'] }] })).status).toBe(400)
    expect((await post({ ...body, questionId: '0'.repeat(64) })).status).toBe(409)
    expect((await post(body, b.id)).status).toBe(409)
    expect((await post(body, 'missing')).status).toBe(404)
    expect(dispatches).toHaveLength(0)
})

test('free text, options, multiple and skipped answers use canonical question text and the conversation model', async () => {
    const question = await pending(), body = answer(question)
    const response = await post(body)
    expect(response.status).toBe(200); expect(response.headers.get('x-question-id')).toBe(question.id)
    expect(response.headers.get('x-session-id')).toBe(a.id); expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].message).toBe(serializeAnswers(questions.map((item, index) => ({ question: item.question, answers: values[index] }))))
    expect(dispatches[0]).toMatchObject({ connectionId: 'provider', model: 'chat-model', sessionId: 'engine-a', desktopQueuedTurn: { runId: body.requestId, question: { sourceMessageId: question.messageId, toolCallId: question.toolCallId } } })
    expect(dispatches[0]).not.toHaveProperty('workspaceAttachment')
    expect(await pending()).toBeNull()
})

test('simultaneous same-answer submissions canonicalize fresh UUIDs and cannot answer another later question', async () => {
    const question = await pending(), first = answer(question), second = answer(question)
    const responses = await Promise.all([post(first), post(second)])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(new Set(responses.map(response => response.headers.get('x-run-id'))).size).toBe(1)
    const canonical = responses[0].headers.get('x-run-id')
    expect(dispatches).toHaveLength(1)
    expect((await post(answer(question, [['Changed'], ['Blue'], [], []]))).status).toBe(409)
    histories.get('engine-a')!.push(...questionRows('engine-a', 'ask_user', 'call-1', { questions: [{ question: 'A later question?' }] }))
    const later = await pending(); expect(later.id).not.toBe(question.id)
    const reads = historyReads
    const retry = await post(answer(question))
    expect(retry.status).toBe(200); expect(retry.headers.get('x-run-id')).toBe(canonical)
    expect(historyReads).toBe(reads); expect(dispatches).toHaveLength(1)
    expect((await post({ ...answer(later, [['yes']]), requestId: second.requestId })).status).toBe(409)
})

test('a lost local acceptance write reconciles after restart and disable without a second run', async () => {
    const question = await pending(), body = answer(question), db = await openDesktopDatabase(root)
    await db.execute("CREATE TRIGGER lose_question_ack BEFORE UPDATE OF accepted ON desktop_question_answers BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END")
    expect((await post(body)).status).toBe(500)
    expect(dispatches).toHaveLength(1)
    await db.execute('DROP TRIGGER lose_question_ack')
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [alice.id] })
    await closeDesktopDatabase(root)
    runtime.app.origin = 'http://127.0.0.1:3193'; runtime.launchNonce = 'restarted'
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const reads = historyReads, models = modelReads
    const retry = await post(answer(question))
    expect(retry.status).toBe(200); expect(retry.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1); expect(historyReads).toBe(reads); expect(modelReads).toBe(models)
    expect((await (await openDesktopDatabase(root)).execute('SELECT accepted FROM desktop_question_answers')).rows[0].accepted).toBe(1)
})

test('an unaccepted answer survives restart for review and retries its original UUID', async () => {
    const question = await pending(), body = answer(question)
    rejectBeforeAccept = true
    expect((await post(body)).status).toBe(502)
    await closeDesktopDatabase(root)
    const restored = await pending()
    expect(restored.attempt).toEqual({ requestId: body.requestId, action: 'answer', answers: [['Rerun Mac'], ...values.slice(1)] })
    rejectBeforeAccept = false
    const response = await post(answer(question))
    expect(response.status).toBe(200); expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(receipts.size).toBe(1)
})

test('expired unaccepted attempts and cancel/answer races cannot act on a newer question', async () => {
    const question = await pending(), body = answer(question)
    rejectBeforeAccept = true; expect((await post(body)).status).toBe(502); rejectBeforeAccept = false
    histories.get('engine-a')!.push(message('engine-a', 'user', 'Move on'), ...questionRows('engine-a', 'ask_user', 'new-call', { questions: [{ question: 'New question?' }] }))
    expect((await post(body)).status).toBe(409); expect(receipts.size).toBe(0)
    const later = await pending(), cancel: DesktopQuestionAnswer = { questionId: later.id, requestId: crypto.randomUUID(), action: 'cancel' }
    const results = await Promise.all([post(cancel), post(answer(later, [['yes']]))])
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    expect(dispatches.at(-1)?.message).toBe(results[0].status === 200 ? HITL_CANCELLED.question : serializeAnswers([{ question: 'New question?', answers: ['yes'] }]))
    expect(receipts.size).toBe(1)
    const invalid = answer(await pending(b.id), [['one', 'two'], [], [], []])
    expect((await post(invalid, b.id)).status).toBe(400)
})

test('cancel serializes the original dismissal protocol and its retries keep the same run', async () => {
    const question = await pending(), body: DesktopQuestionAnswer = { questionId: question.id, requestId: crypto.randomUUID(), action: 'cancel' }
    const response = await post(body)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].message).toBe(HITL_CANCELLED.question)
    const replay = await post({ ...body, requestId: crypto.randomUUID() })
    expect(replay.status).toBe(200); expect(replay.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1)
    expect(await pending()).toBeNull()
})
