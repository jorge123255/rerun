import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { findDesktopApproval, findDesktopQuestion, type Message } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import { readDesktopApproval } from '@/lib/desktop/server/approvals'
import { readDesktopQuestion } from '@/lib/desktop/server/questions'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET } from './route'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent
let question: DesktopSession, approval: DesktopSession, acceptedQuestion: DesktopSession, acceptedApproval: DesktopSession, bobChat: DesktopSession
const time = '2026-11-04T12:00:00.000Z'
const histories = new Map<string, { owner: string; rows: Message[] }>(), calls: string[] = [], failures = new Set<string>(), stalled = new Set<string>()
function rows(sessionId: string, kind: 'question' | 'approval'): Message[] {
    const requestedAt = sessionId === 'approval' ? '2026-11-06T12:00:00.000Z' : sessionId === 'question' ? '2026-11-05T12:00:00.000Z' : time
    const toolName = kind === 'question' ? 'ask_user' : 'request_approval'
    const input = kind === 'question' ? { questions: [{ question: 'Which color should I use?', options: ['Blue', 'Orange'] }] }
        : { approvals: [{ action: 'Publish the draft', detail: 'Details belong inside the chat card.' }] }
    return [
        { id: sessionId + '-request', sessionId, role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName, toolCallId: sessionId + '-call', input }]), toolCallsJson: null, createdAt: requestedAt },
        { id: sessionId + '-result', sessionId, role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolName, toolCallId: sessionId + '-call', output: { type: 'json', value: { status: 'delivered' } } }]), toolCallsJson: null, createdAt: requestedAt },
    ]
}
function request(headers: Record<string, string> = {}) {
    return new Request(runtime.app.origin + '/api/desktop/attention', { headers: {
        host: new URL(runtime.app.origin).host, cookie: 'rerun-desktop-session=' + runtime.app.sessionToken, ...headers,
    } })
}
const get = () => GET(request())

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-attention-api-'))
    histories.clear(); calls.length = 0; failures.clear(); stalled.clear()
    server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`)
        const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        const history = req.url?.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/)
        if (req.method === 'GET' && history) {
            if (stalled.has(history[2])) return
            if (failures.has(history[2])) return reply(503, { error: 'Unavailable private fixture details' })
            const found = histories.get(history[2])
            return reply(found?.owner === history[1] ? 200 : 404, found?.owner === history[1] ? { messages: found.rows } : { error: 'Not found' })
        }
        return reply(404, { error: 'Unexpected fixture request' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'attention-api', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3197', sessionToken: 'a'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' })
    bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    const seed = async (owner: DesktopAgent, engineId: string, kind: 'question' | 'approval') => {
        const local = await createDesktopSession(db, { agentId: owner.id, engineSessionId: engineId, title: 'Chat ' + engineId })
        histories.set(engineId, { owner: owner.engineAgentId, rows: rows(engineId, kind) })
        return local
    }
    question = await seed(alice, 'question', 'question'); approval = await seed(alice, 'approval', 'approval')
    acceptedQuestion = await seed(alice, 'accepted-question', 'question'); acceptedApproval = await seed(alice, 'accepted-approval', 'approval')
    bobChat = await seed(bob, 'bob-question', 'question')
    const q = (await readDesktopQuestion(runtime, acceptedQuestion.id)).question!
    const a = (await readDesktopApproval(runtime, acceptedApproval.id)).approval!
    const pendingQuestion = findDesktopQuestion(histories.get(acceptedQuestion.engineSessionId)!.rows)!
    const pendingApproval = findDesktopApproval(histories.get(acceptedApproval.engineSessionId)!.rows)!
    const questionGuard = { sourceMessageId: pendingQuestion.sourceMessageId, toolCallId: pendingQuestion.toolCallId, fingerprint: pendingQuestion.fingerprint }
    const approvalGuard = { sourceMessageId: pendingApproval.sourceMessageId, toolCallId: pendingApproval.toolCallId, fingerprint: pendingApproval.fingerprint }
    await db.execute({ sql: 'INSERT INTO desktop_question_answers (request_id,agent_id,session_id,question_id,question_guard,payload,answer_text,accepted,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [crypto.randomUUID(), alice.id, acceptedQuestion.id, q.id, JSON.stringify(questionGuard), '{"action":"cancel"}', 'Dismissed', 1, time] })
    await db.execute({ sql: 'INSERT INTO desktop_approval_answers (request_id,agent_id,session_id,approval_id,approval_guard,payload,answer_text,accepted,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [crypto.randomUUID(), alice.id, acceptedApproval.id, a.id, JSON.stringify(approvalGuard), '{"decisions":[{"decision":"declined"}]}', 'Declined', 1, time] })
    await db.execute({ sql: 'UPDATE desktop_sessions SET updated_at = ? WHERE id = ?', args: ['2026-11-06T12:00:00.000Z', approval.id] })
    await db.execute({ sql: 'UPDATE desktop_sessions SET updated_at = ? WHERE id = ?', args: ['2026-11-05T12:00:00.000Z', question.id] })
    await db.execute({ sql: 'UPDATE desktop_sessions SET updated_at = ? WHERE id = ?', args: [time, bobChat.id] })
    calls.length = 0
})
afterEach(async () => {
    vi.restoreAllMocks()
    await closeDesktopDatabase(root); process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('authenticated GET projects receipt-aware questions and approvals without changing any answer receipts', async () => {
    const db = await openDesktopDatabase(root)
    const before = await db.batch(['SELECT * FROM desktop_question_answers', 'SELECT * FROM desktop_approval_answers', 'SELECT * FROM desktop_question_requests', 'SELECT * FROM desktop_approval_requests'], 'read')
    const response = await get(), body = await response.json()
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.items.map((item: { sessionId: string }) => item.sessionId)).toEqual([approval.id, question.id, bobChat.id])
    expect(body.items[0]).toMatchObject({ kind: 'approval', agentId: alice.id, agentName: 'Alice', title: 'Chat approval', summary: 'Publish the draft' })
    expect(body.items[1]).toMatchObject({ kind: 'question', summary: 'Which color should I use?' })
    expect(body.unavailableAgentIds).toEqual([])
    expect(JSON.stringify(body)).not.toContain('engine-alice')
    expect(JSON.stringify(body)).not.toContain('Details belong')
    expect(calls.every(call => call.startsWith('GET '))).toBe(true)
    const after = await db.batch(['SELECT * FROM desktop_question_answers', 'SELECT * FROM desktop_approval_answers', 'SELECT * FROM desktop_question_requests', 'SELECT * FROM desktop_approval_requests'], 'read')
    expect(after.map(result => result.rows)).toEqual(before.map(result => result.rows))
})

test('restart retains accepted suppression and disabled coworkers retain their pending navigation items', async () => {
    const before = await (await get()).json()
    await (await openDesktopDatabase(root)).execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [bob.id] })
    await closeDesktopDatabase(root)
    const after = await (await get()).json()
    expect(after.items.map((item: { id: string }) => item.id)).toEqual(before.items.map((item: { id: string }) => item.id))
    expect(after.items.find((item: { agentId: string }) => item.agentId === bob.id)).toMatchObject({ agentEnabled: false, sessionId: bobChat.id })
})

test('request age follows its source message without changing identity or accepted receipts', async () => {
    const before = await (await get()).json()
    const db = await openDesktopDatabase(root)
    // Updating a session or receiving a later tool result must not make its old request new.
    await db.execute({ sql: 'UPDATE desktop_sessions SET updated_at=? WHERE id=?', args: ['2030-01-01T00:00:00.000Z', bobChat.id] })
    histories.get(question.engineSessionId)!.rows[1]!.createdAt = '2030-01-02T00:00:00.000Z'
    const unchanged = await (await get()).json()
    expect(unchanged.items.map((item: { sessionId: string }) => item.sessionId)).toEqual([approval.id, question.id, bobChat.id])
    expect(unchanged.items.find((item: { sessionId: string }) => item.sessionId === question.id).requestedAt).toBe('2026-11-05T12:00:00.000Z')

    histories.get(question.engineSessionId)!.rows[0]!.createdAt = '2026-11-07T12:00:00.000Z'
    histories.get(acceptedQuestion.engineSessionId)!.rows[0]!.createdAt = '2026-11-08T12:00:00.000Z'
    histories.get(acceptedApproval.engineSessionId)!.rows[0]!.createdAt = '2026-11-08T12:00:00.000Z'
    const after = await (await get()).json()
    expect(after.items.map((item: { sessionId: string }) => item.sessionId)).toEqual([question.id, approval.id, bobChat.id])
    expect(after.items.map((item: { id: string }) => item.id).sort()).toEqual(before.items.map((item: { id: string }) => item.id).sort())
    expect(after.items[0].requestedAt).toBe('2026-11-07T12:00:00.000Z')
})

test('foreign or missing engine history is unavailable without leaking another chat, and a subsequent read recovers', async () => {
    histories.set(question.engineSessionId, { owner: alice.engineAgentId, rows: rows(bobChat.engineSessionId, 'question') })
    histories.delete(approval.engineSessionId)
    failures.add(bobChat.engineSessionId)
    const body = await (await get()).json()
    expect(body.items).toEqual([])
    expect(body.unavailableAgentIds).toEqual([alice.id, bob.id].sort())
    expect(JSON.stringify(body)).not.toContain('private fixture details')
    histories.set(question.engineSessionId, { owner: alice.engineAgentId, rows: rows(question.engineSessionId, 'question') })
    histories.set(approval.engineSessionId, { owner: alice.engineAgentId, rows: rows(approval.engineSessionId, 'approval') })
    failures.clear()
    expect((await (await get()).json()).items).toHaveLength(3)
})

test('a later user turn resolves attention, deleting a coworker removes only its targets, and authentication precedes engine reads', async () => {
    histories.get(question.engineSessionId)!.rows.push({ id: 'answer', sessionId: question.engineSessionId, role: 'user', contentJson: JSON.stringify([{ type: 'text', text: 'Blue' }]), toolCallsJson: null, createdAt: time })
    expect((await (await get()).json()).items.map((item: { sessionId: string }) => item.sessionId)).toEqual([approval.id, bobChat.id])
    await (await openDesktopDatabase(root)).execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [alice.id] })
    expect((await (await get()).json()).items.map((item: { sessionId: string }) => item.sessionId)).toEqual([bobChat.id])
    calls.length = 0
    expect((await GET(request({ cookie: 'rerun-desktop-session=wrong' }))).status).toBe(401)
    expect((await GET(request({ host: 'example.com' }))).status).toBe(403)
    expect((await GET(request({ 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    expect(calls).toEqual([])
})

test('the scan deadline reaches real HTTP history reads, cancels stalled requests and permits a fresh recovery scan', async () => {
    for (const id of histories.keys()) stalled.add(id)
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const pending = get()
    try {
        await vi.waitFor(() => expect(calls).toHaveLength(4))
        expect(timeout).toHaveBeenCalledExactlyOnceWith(2_500)
        controller.abort(new DOMException('Attention deadline', 'TimeoutError'))
        const response = await pending
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ items: [], unavailableAgentIds: [alice.id, bob.id].sort() })
        expect(calls).toHaveLength(4)
    } finally {
        controller.abort(); timeout.mockRestore(); stalled.clear()
    }
    expect((await (await get()).json()).items).toHaveLength(3)
})

test('a pending item ages by its source request message, not by the chat that raised it', async () => {
    // The older request sits in the session that sorts first and was created last, so a chat
    // activity timestamp would order it first; the request message's own timestamp must win.
    const db = await openDesktopDatabase(root)
    const newerSession = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'age-new', title: 'Newer request' })
    const olderSession = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'age-old', title: 'Older request' })
    await closeDesktopDatabase(root)
    const ageRows = (sessionId: string, createdAt: string): Message[] => [
        { id: sessionId + '-request', sessionId, role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName: 'ask_user', toolCallId: sessionId + '-call', input: { questions: [{ question: 'Which color should I use?', options: ['Blue'] }] } }]), toolCallsJson: null, createdAt },
        { id: sessionId + '-result', sessionId, role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolName: 'ask_user', toolCallId: sessionId + '-call', output: { type: 'json', value: { status: 'delivered' } } }]), toolCallsJson: null, createdAt },
    ]
    histories.set('age-new', { owner: alice.engineAgentId, rows: ageRows('age-new', '2099-01-01T00:00:00.000Z') })
    histories.set('age-old', { owner: alice.engineAgentId, rows: ageRows('age-old', '2020-01-01T00:00:00.000Z') })
    const body = await (await get()).json() as { items: { sessionId: string; requestedAt?: string }[] }
    const newItem = body.items.find(item => item.sessionId === newerSession.id)!
    const oldItem = body.items.find(item => item.sessionId === olderSession.id)!
    expect(newItem.requestedAt).toBe('2099-01-01T00:00:00.000Z')
    expect(oldItem.requestedAt).toBe('2020-01-01T00:00:00.000Z')
    expect(body.items[0]!.sessionId).toBe(newerSession.id)
    expect(body.items.at(-1)!.sessionId).toBe(olderSession.id)
    histories.delete('age-new'); histories.delete('age-old')
})
