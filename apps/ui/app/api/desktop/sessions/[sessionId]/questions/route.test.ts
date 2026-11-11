import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { findDesktopQuestion, HITL_CANCELLED, serializeAnswers, type Message } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import type { DesktopPendingQuestion, DesktopQuestionAnswer } from '@/lib/desktop/questions'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET, POST } from './route'
import { POST as TRANSCRIBE } from './transcribe/route'
import { composerTestPng } from '@/lib/desktop/server/composer-image.test-fixtures'
import { desktopAuxiliaryStore } from '@/lib/desktop/server/auxiliary/store'
import { GET as GET_FILES, POST as POST_FILES } from '@/app/api/desktop/coworkers/[agentId]/document-attachments/route'
import { POST as POST_CHAT } from '@/app/api/desktop/chat/route'
import { questionDocumentTabUid, QUESTION_DOCUMENT_POSITIONS } from '@/lib/desktop/question-documents'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent, a: DesktopSession, b: DesktopSession
let rejectBeforeAccept: boolean, foreignHistory: boolean, historyReads: number, modelReads: number
let sourceUnavailable: boolean
let fixtureProvider: 'codex' | 'openrouter'
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
const recording = {
    format: { mimeType: 'audio/webm;codecs=opus', extension: 'webm', transcriptionFormat: 'webm' },
    durationMs: 1000, levels: [0.1], audioBase64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from('fixture-webm')]).toString('base64'),
}
const transcribe = (input: unknown, sessionId = a.id, headers?: Record<string, string>) => TRANSCRIBE(
    request(sessionId, 'POST', input, headers), { params: Promise.resolve({ sessionId }) },
)

beforeEach(async () => {
    sourceUnavailable = false
    fixtureProvider = 'codex'
    root = await mkdtemp(join(tmpdir(), 'rerun-question-api-'))
    histories.clear(); receipts.clear(); dispatches.length = 0; rejectBeforeAccept = false; foreignHistory = false; historyReads = 0; modelReads = 0
    server = createServer(async (req, res) => {
        let raw = ''; for await (const part of req) raw += part
        const body = raw ? JSON.parse(raw) : null
        const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
        if (req.method === 'POST' && req.url === '/desktop/triggers/manage') {
            if (req.headers.authorization !== `Bearer ${runtime.engine.apiKey}` || body.launchNonce !== runtime.launchNonce) return reply(403, { error: 'Wrong fixture launch' })
            const owner = body.engineAgentId === 'engine-alice' ? alice : body.engineAgentId === 'engine-bob' ? bob : null
            const sessionId = owner === alice ? 'engine-a' : 'engine-b'
            if (!owner || body.localAgentId !== owner.id || body.op !== 'session' || body.input?.sessionId !== sessionId) return reply(409, { error: 'Wrong fixture source' })
            if (sourceUnavailable) return reply(503, { error: 'Source identity unavailable' })
            // These are ordinary chats, proven by the canonical engine source lookup.
            return reply(200, { result: { event: null } })
        }
        if (req.method === 'GET' && /^\/agents\/(engine-alice|engine-bob)\/setup$/.test(req.url ?? '')) return reply(200, {
            required: false, prompt: '', completedAt: null, sessionId: null, pending: false, revision: 'fixture-setup',
        })
        if (req.method === 'GET' && req.url === '/connections') {
            modelReads++
            return reply(200, { connections: [{ id: 'provider', name: 'Fixture', provider: fixtureProvider, models: ['workspace-model', 'chat-model'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }], default: { connectionId: 'provider', model: 'workspace-model' } })
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
            const identity = JSON.stringify([chat[1], body.sessionId, body.message, turn?.question, turn?.documents])
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
    vi.unstubAllGlobals()
    await closeDesktopDatabase(root); process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('transcribes only a current owned question and does not save or dispatch the voice answer', async () => {
    const question = await pending()
    const input = { ...recording, questionId: question.id }
    const db = await openDesktopDatabase(root)
    process.env.RERUN_DESKTOP_SECRET_KEY = 'ab'.repeat(32)
    const nativeFetch = globalThis.fetch
    const provider = vi.fn(async () => Response.json({ text: 'Speak the quarterly review' }))
    vi.stubGlobal('fetch', (target: string | URL | Request, options?: RequestInit) =>
        String(target) === 'https://openrouter.ai/api/v1/audio/transcriptions' ? provider() : nativeFetch(target, options))

    expect((await transcribe(input, a.id, { cookie: 'invalid' })).status).toBe(401)
    expect((await transcribe(input, b.id)).status).toBe(409)
    expect((await transcribe({ ...input, audioBase64: 'aW52YWxpZA==' })).status).toBe(400)
    expect((await transcribe(input)).status).toBe(503)
    expect(provider).not.toHaveBeenCalled()
    await desktopAuxiliaryStore(db).change({ purpose: 'transcription', expectedRevision: 'unconfigured', key: 'synthetic-key' })
    const result = await transcribe(input)
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toEqual({ transcript: 'Speak the quarterly review' })
    expect(await pending()).toEqual(question)
    expect((await db.execute('SELECT * FROM desktop_question_answers')).rows).toEqual([])
    expect(dispatches).toEqual([])
    expect(provider).toHaveBeenCalledOnce()

    provider.mockImplementationOnce(async () => {
        histories.set('engine-a', questionRows('engine-a', 'ask_user', 'new-call'))
        return Response.json({ text: 'This transcript must not reach the new question' })
    })
    expect((await transcribe(input)).status).toBe(409)
    expect(provider).toHaveBeenCalledTimes(2)
    expect(dispatches).toEqual([])
})

async function restartQuestionFixture() {
    await closeDesktopDatabase(root)
    runtime = { ...runtime, launchNonce: crypto.randomUUID() }
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime))
}

test('retains a file-only answer for its exact question and reconciles with the same bytes after restart', async () => {
    const question = await pending()
    const scope = { agentId: alice.id, sessionId: a.id, tabUid: questionDocumentTabUid(question.id) }
    const attachmentId = crypto.randomUUID()
    const documents = { scope, admissionId: crypto.randomUUID(), attachmentIds: [attachmentId] }
    const url = (agentId: string) => `${runtime.app.origin}/api/desktop/coworkers/${agentId}/document-attachments`
    const headers = { origin: runtime.app.origin, host: new URL(runtime.app.origin).host, 'content-type': 'application/json',
        cookie: 'rerun-desktop-session=' + runtime.app.sessionToken }
    const upload = { ...scope, operation: 'upload', attachmentId, name: 'quarterly [draft].txt', mimeType: 'text/plain',
        position: QUESTION_DOCUMENT_POSITIONS, audioBase64: Buffer.from('Original quarterly figures').toString('base64') }
    const files = (input: object, agentId = alice.id) => POST_FILES(new Request(url(agentId), {
        method: 'POST', headers, body: JSON.stringify(input),
    }), { params: Promise.resolve({ agentId }) })
    expect((await files({ ...upload, agentId: bob.id }, bob.id)).status).toBe(409)
    const saved = await files(upload)
    expect(saved.status).toBe(200)
    const { attachment } = await saved.json()
    expect(attachment).toMatchObject({ kind: 'text', conversion: { mode: 'plain-text', state: 'ready' } })
    await restartQuestionFixture()
    const listing = await GET_FILES(new Request(url(alice.id) + '?' + new URLSearchParams({
        sessionId: a.id, tabUid: scope.tabUid,
    }), { headers }), { params: Promise.resolve({ agentId: alice.id }) })
    const listed = await listing.json()
    expect(listing.status, JSON.stringify(listed)).toBe(200)
    expect(listed.attachments).toEqual([attachment])

    const ordinary = await POST_CHAT(new Request(runtime.app.origin + '/api/desktop/chat', {
        method: 'POST', headers, body: JSON.stringify({ agentId: alice.id, sessionId: a.id, text: 'ordinary chat', documents }),
    }))
    expect(ordinary.status).toBe(409)
    expect(dispatches).toHaveLength(0)
    const body = { ...answer(question, [[], [], [], []]), documents }
    rejectBeforeAccept = true
    expect((await post(body)).status).toBe(502)
    await restartQuestionFixture()
    expect((await pending()).attempt).toMatchObject({ requestId: body.requestId, documents })
    expect((await post({ ...body, documents: { ...documents, attachmentIds: [crypto.randomUUID()] } })).status).toBe(409)
    rejectBeforeAccept = false
    const response = await post(body)
    expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(2)
    expect(dispatches[1]).toMatchObject({
        message: expect.stringContaining('**Choose a color**\nAttached: quarterly [draft].txt'),
        desktopQueuedTurn: { runId: body.requestId, documents },
        desktopDocuments: [{ text: 'Original quarterly figures', reference: { attachmentId, scope, sha256: attachment.sha256 } }],
    })
    expect(dispatches[1].message).not.toContain('Attachments added to your workspace')
    await restartQuestionFixture()
    expect((await post(body)).headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(2)
    const download = await GET_FILES(new Request(url(alice.id) + '?' + new URLSearchParams({
        sessionId: a.id, tabUid: scope.tabUid, attachmentId, sha256: attachment.sha256, view: 'download',
    }), { headers }), { params: Promise.resolve({ agentId: alice.id }) })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('Original quarterly figures')
})

test('saves an image with its question, refuses a text-only model, and sends the original PNG with mixed answers', async () => {
    const question = await pending()
    const scope = { agentId: alice.id, sessionId: a.id, tabUid: questionDocumentTabUid(question.id) }
    const url = `${runtime.app.origin}/api/desktop/coworkers/${alice.id}/document-attachments`
    const headers = { origin: runtime.app.origin, host: new URL(runtime.app.origin).host, 'content-type': 'application/json',
        cookie: 'rerun-desktop-session=' + runtime.app.sessionToken }
    const imageBytes = Buffer.from(composerTestPng())
    const imageId = crypto.randomUUID(), textId = crypto.randomUUID()
    const image = { ...scope, operation: 'upload', attachmentId: imageId, name: 'sample.png', mimeType: 'image/png',
        position: QUESTION_DOCUMENT_POSITIONS, audioBase64: imageBytes.toString('base64') }
    const files = (input: object) => POST_FILES(new Request(url, { method: 'POST', headers, body: JSON.stringify(input) }),
        { params: Promise.resolve({ agentId: alice.id }) })
    const corrupt = await files({ ...image, audioBase64: Buffer.from('Wrong file').toString('base64') })
    expect(corrupt.status).toBe(415)
    const saved = await files(image)
    expect(saved.status).toBe(200)
    const { attachment } = await saved.json()
    expect(attachment).toMatchObject({ kind: 'image', conversion: { mode: 'image', state: 'ready' } })
    expect((await files({ ...image, attachmentId: textId, name: 'sample.txt', mimeType: 'text/plain',
        position: 0, audioBase64: Buffer.from('These are supporting notes').toString('base64') })).status).toBe(200)
    await restartQuestionFixture()
    const query = new URLSearchParams({ tabUid: scope.tabUid, sessionId: scope.sessionId, attachmentId: imageId, sha256: attachment.sha256, view: 'preview' })
    const preview = await GET_FILES(new Request(url + '?' + query, { headers }), { params: Promise.resolve({ agentId: alice.id }) })
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(imageBytes)

    const documents = { scope, admissionId: crypto.randomUUID(), attachmentIds: [textId, imageId] }
    const body = { ...answer(question, [['Start'], [], [], []]), documents }
    fixtureProvider = 'openrouter'
    expect((await post(body)).status).toBe(400)
    expect((await pending()).attempt).toBeUndefined()
    expect(dispatches).toHaveLength(0)

    fixtureProvider = 'codex'
    const result = await post(body)
    expect(result.status).toBe(200)
    expect(dispatches[0]).toMatchObject({ desktopDocuments: [
        { reference: { attachmentId: textId }, text: 'These are supporting notes' },
        { reference: { attachmentId: imageId, sha256: attachment.sha256 }, dataBase64: image.audioBase64 },
    ], desktopQueuedTurn: { documents } })
    await restartQuestionFixture()
    expect((await post(body)).headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1)
})

test('an unavailable source lookup cannot bypass webhook authority and dispatch an ordinary reply', async () => {
    const body = answer(await pending())
    sourceUnavailable = true
    expect((await post(body)).status).toBe(503)
    expect(dispatches).toHaveLength(0)
    expect(receipts.size).toBe(0)
    expect((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_question_answers')).rows).toHaveLength(0)
    sourceUnavailable = false
    fixtureProvider = 'codex'
    const response = await post(body)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1)
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

test('an explicit skip is an accepted answer, survives relaunch, and stays separate from a pending or dismissed request', async () => {
    expect((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_question_answers')).rows).toHaveLength(0)
    const question = await pending()
    const skipped = question.questions.map(() => [] as string[])
    const body = answer(question, skipped)
    const response = await post(body)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-question-id')).toBe(question.id)
    const text = String(dispatches[0].message)
    expect(text).toBe(serializeAnswers(question.questions.map(item => ({ question: item.question, answers: [] }))))
    expect(text).toContain('[skipped]')
    expect(text).not.toBe(HITL_CANCELLED.question)
    const saved = (await (await openDesktopDatabase(root)).execute('SELECT payload, answer_text, accepted FROM desktop_question_answers')).rows[0]
    expect(JSON.parse(String(saved.payload))).toEqual({ action: 'answer', answers: skipped.map(() => []) })
    expect(saved.answer_text).toBe(text)
    expect(saved.accepted).toBe(1)
    await closeDesktopDatabase(root)
    runtime.launchNonce = 'skip-relaunch'
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    expect(await pending()).toBeNull()
    const other = await pending(b.id)
    expect(other.id).not.toBe(question.id)
    const dismissed = await post({ questionId: other.id, requestId: crypto.randomUUID(), action: 'cancel' }, b.id)
    expect(dismissed.status).toBe(200)
    expect(dispatches.at(-1)?.message).toBe(HITL_CANCELLED.question)
    expect(String(dispatches.at(-1)?.message)).not.toContain('[skipped]')
})

test('a rejected ask_user result and a disabled coworker cannot be recorded as a skip', async () => {
    const question = await pending()
    histories.get('engine-a')![1].contentJson = JSON.stringify([{ type: 'tool-result', toolCallId: 'call-1', output: { type: 'error-text', value: 'Rejected' } }])
    const skipped = question.questions.map(() => [] as string[])
    expect((await post(answer(question, skipped))).status).toBe(409)
    expect(dispatches).toHaveLength(0)
    expect((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_question_answers')).rows).toHaveLength(0)
    histories.set('engine-a', questionRows('engine-a'))
    const restored = await pending()
    await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [alice.id] })
    expect((await post(answer(restored, skipped))).status).toBe(403)
    const row = (await (await openDesktopDatabase(root)).execute('SELECT accepted FROM desktop_question_answers')).rows[0]
    expect(Number(row?.accepted ?? 0)).toBe(0)
    expect((await pending())?.id).toBe(restored.id)
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
