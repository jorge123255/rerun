import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Message } from '@rerun/contracts'
import { desktopPendingInboxSchema, type DesktopPendingReadTarget } from '@/lib/desktop/pending-inbox'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopApproval } from '@/lib/desktop/server/approvals'
import * as questionResolvers from '@/lib/desktop/server/questions'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import { GET } from './route'
import { POST } from './read/route'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent
let question: DesktopSession, approval: DesktopSession, bobChat: DesktopSession
const time = '2026-11-04T12:00:00.000Z'
const histories = new Map<string, { owner: string; rows: Message[] }>(), calls: string[] = [], failures = new Set<string>(), stalled = new Set<string>()
function rows(sessionId: string, kind: 'question' | 'approval'): Message[] {
    const toolName = kind === 'question' ? 'ask_user' : 'request_approval'
    const input = kind === 'question' ? { questions: [{ question: 'Which color should I use?', options: ['Blue', 'Orange'] }] }
        : { approvals: [{ action: 'Publish the draft', detail: 'Details belong inside the chat card.' }] }
    return [
        { id: sessionId + '-request', sessionId, role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName, toolCallId: sessionId + '-call', input }]), toolCallsJson: null, createdAt: time },
        { id: sessionId + '-result', sessionId, role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolName, toolCallId: sessionId + '-call', output: { type: 'json', value: { status: 'delivered' } } }]), toolCallsJson: null, createdAt: time },
    ]
}
function request(path = '', body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${runtime.app.origin}/api/desktop/pending-inbox${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin,
            cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
}
const get = () => GET(request())
const mark = (items: DesktopPendingReadTarget[]) => POST(request('/read', { items }))
async function read() {
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return desktopPendingInboxSchema.parse(await response.json())
}
const seen = async () => (await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_pending_inbox_seen')).rows
const questionId = async () => (await questionResolvers.readDesktopQuestion(runtime, question.id)).question!.id
const approvalId = async () => (await readDesktopApproval(runtime, approval.id)).approval!.id

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-pending-inbox-api-'))
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
    runtime = { protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'pending-inbox-api', workspaceId: 1, dataRoot: root,
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
    bobChat = await seed(bob, 'bob-question', 'question')
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

test('GET projects the shared attention minus the inbox receipts, and mark-read is idempotent without touching answer receipts', async () => {
    const db = await openDesktopDatabase(root)
    const before = await db.batch(['SELECT * FROM desktop_question_answers', 'SELECT * FROM desktop_approval_answers', 'SELECT * FROM desktop_question_requests', 'SELECT * FROM desktop_approval_requests'], 'read')
    expect((await read()).items.map(item => item.sessionId)).toEqual([approval.id, question.id, bobChat.id])

    const q1 = await questionId(), a1 = await approvalId()
    // Re-post the same target twice and one duplicate batch: the upsert stays idempotent.
    expect(await (await mark([{ id: q1, kind: 'question', agentId: alice.id, sessionId: question.id }])).json()).toEqual({ marked: 1, failedIds: [] })
    expect(await (await mark([{ id: q1, kind: 'question', agentId: alice.id, sessionId: question.id }])).json()).toEqual({ marked: 1, failedIds: [] })
    expect(await (await mark([{ id: a1, kind: 'approval', agentId: alice.id, sessionId: approval.id }, { id: a1, kind: 'approval', agentId: alice.id, sessionId: approval.id }])).json()).toEqual({ marked: 1, failedIds: [] })

    const body = await read()
    expect(body.items.map(item => item.sessionId)).toEqual([bobChat.id])
    expect(await seen()).toHaveLength(2)
    // Only inbox-read receipts were written: no answer or approval receipts, no request rows.
    const after = await db.batch(['SELECT * FROM desktop_question_answers', 'SELECT * FROM desktop_approval_answers', 'SELECT * FROM desktop_question_requests', 'SELECT * FROM desktop_approval_requests'], 'read')
    expect(after.map(result => result.rows.length)).toEqual(before.map(result => result.rows.length))
    expect(after.every(result => result.rows.length === 0)).toBe(true)
})

test('database startup creates the receipt table and reopening preserves the exact read request', async () => {
    // No pending-inbox route has run yet: startup, rather than lazy route setup, owns the table.
    expect(await seen()).toEqual([])
    const q1 = await questionId()
    expect(await (await mark([{ id: q1, kind: 'question', agentId: alice.id, sessionId: question.id }])).json()).toEqual({ marked: 1, failedIds: [] })
    await closeDesktopDatabase(root)
    expect((await seen()).map(row => String(row.item_id))).toEqual([q1])
    expect((await read()).items.map(item => item.sessionId)).toEqual([approval.id, bobChat.id])
    // Reading the inbox never resolves the underlying request.
    expect(await questionId()).toBe(q1)
})

test('a new request in the same chat reappears, and the earlier receipt cannot block it', async () => {
    const q1 = await questionId()
    expect(await (await mark([{ id: q1, kind: 'question', agentId: alice.id, sessionId: question.id }])).json()).toEqual({ marked: 1, failedIds: [] })
    expect((await read()).items.map(item => item.sessionId)).toEqual([approval.id, bobChat.id])

    // The user answers; the same session asks a new question, a fresh request identity.
    histories.get(question.engineSessionId)!.rows.push({ id: 'answer', sessionId: question.engineSessionId, role: 'user', contentJson: JSON.stringify([{ type: 'text', text: 'Blue' }]), toolCallsJson: null, createdAt: time })
    const sessionId = question.engineSessionId
    histories.get(sessionId)!.rows.push(
        { id: sessionId + '-request-2', sessionId, role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName: 'ask_user', toolCallId: sessionId + '-call-2', input: { questions: [{ question: 'Which size should I pick?', options: ['S', 'L'] }] } }]), toolCallsJson: null, createdAt: time },
        { id: sessionId + '-result-2', sessionId, role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolName: 'ask_user', toolCallId: sessionId + '-call-2', output: { type: 'json', value: { status: 'delivered' } } }]), toolCallsJson: null, createdAt: time },
    )
    const fresh = (await read()).items.find(item => item.sessionId === question.id)
    expect(fresh).toBeTruthy()
    expect(fresh!.id).not.toBe(q1)
    expect(fresh).toMatchObject({ kind: 'question', agentId: alice.id, summary: 'Which size should I pick?' })
    // Marking the stale receipt again cannot touch the newer request.
    expect(await (await mark([{ id: q1, kind: 'question', agentId: alice.id, sessionId: question.id }])).json()).toEqual({ marked: 0, failedIds: [q1] })
    expect((await read()).items.find(item => item.sessionId === question.id)).toBeTruthy()
})

test('stale, forged or unknown targets stay explicit in failedIds and store no receipts', async () => {
    const q1 = await questionId(), a1 = await approvalId()
    // Resolve the question session so the old id is stale.
    histories.get(question.engineSessionId)!.rows.push({ id: 'answer', sessionId: question.engineSessionId, role: 'user', contentJson: JSON.stringify([{ type: 'text', text: 'Blue' }]), toolCallsJson: null, createdAt: time })
    const response = await mark([
        { id: q1, kind: 'question', agentId: alice.id, sessionId: question.id },     // stale: no longer pending
        { id: a1, kind: 'question', agentId: alice.id, sessionId: approval.id },     // wrong kind for that session
        { id: a1, kind: 'approval', agentId: bob.id, sessionId: approval.id },       // forged owner
        { id: 'made-up', kind: 'approval', agentId: alice.id, sessionId: approval.id }, // unknown id
        { id: 'x', kind: 'question', agentId: alice.id, sessionId: 'missing-session' }, // unknown session
    ])
    expect(response.status).toBe(200)
    const body = (await response.json()) as { marked: number; failedIds: string[] }
    expect(body.marked).toBe(0)
    expect(body.failedIds.slice().sort()).toEqual([q1, a1, 'made-up', 'x'].sort())
    expect(await seen()).toEqual([])
})

test('an unreachable engine read stays in failedIds, never a complete success, and the retry recovers', async () => {
    const q1 = await questionId(), a1 = await approvalId()
    failures.add(approval.engineSessionId)
    const response = await mark([
        { id: q1, kind: 'question', agentId: alice.id, sessionId: question.id },
        { id: a1, kind: 'approval', agentId: alice.id, sessionId: approval.id },
    ])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ marked: 1, failedIds: [a1] })
    expect(await seen()).toHaveLength(1)
    // The shared projection cannot confirm the unreachable request. It reports that owner as
    // unavailable rather than inventing a row or presenting a fully known empty inbox.
    const partial = await read()
    expect(partial.items.map(item => item.sessionId)).toEqual([bobChat.id])
    expect(partial.unavailableAgentIds).toEqual([alice.id])
    expect((await seen()).map(row => String(row.item_id))).toEqual([q1])
    failures.clear()
    // No receipt was saved for the failed mark, so the request reappears once it can be read.
    const recovered = await read()
    expect(recovered.items.map(item => item.sessionId)).toEqual([approval.id, bobChat.id])
    expect(recovered.unavailableAgentIds).toEqual([])
    expect(await (await mark([{ id: a1, kind: 'approval', agentId: alice.id, sessionId: approval.id }])).json()).toEqual({ marked: 1, failedIds: [] })
    expect((await read()).items.map(item => item.sessionId)).toEqual([bobChat.id])
})

test('receipts cascade with their chat and coworker while other owners stay readable', async () => {
    const q1 = await questionId(), a1 = await approvalId(), b1 = (await questionResolvers.readDesktopQuestion(runtime, bobChat.id)).question!.id
    const db = await openDesktopDatabase(root)
    await mark([
        { id: q1, kind: 'question', agentId: alice.id, sessionId: question.id },
        { id: a1, kind: 'approval', agentId: alice.id, sessionId: approval.id },
        { id: b1, kind: 'question', agentId: bob.id, sessionId: bobChat.id },
    ])
    expect(await seen()).toHaveLength(3)
    await db.execute({ sql: 'DELETE FROM desktop_sessions WHERE id = ?', args: [question.id] })
    expect(await seen()).toHaveLength(2)
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [alice.id] })
    expect(await seen()).toHaveLength(1)
    expect((await seen()).map(row => String(row.item_id))).toEqual([b1])
})

test('requires authenticated same-origin reads and exact mark-read bodies', async () => {
    const anonymous = request(); anonymous.headers.delete('cookie')
    expect((await GET(anonymous)).status).toBe(401)
    const foreign = request('/read', { items: [] }); foreign.headers.set('origin', 'https://other.invalid')
    expect((await POST(foreign)).status).toBe(403)
    expect((await POST(request('/read', { items: [{ id: 123 }] }))).status).toBe(400)
    expect((await POST(request('/read', { items: [{ id: 'x' }] }))).status).toBe(400)
    expect((await POST(request('/read', { items: 'nope' }))).status).toBe(400)
    expect((await POST(request('/read', {}))).status).toBe(400)
    expect((await POST(request('/read'))).status).toBe(400)
    calls.length = 0
    expect((await GET(request('', undefined, { cookie: 'rerun-desktop-session=wrong' }))).status).toBe(401)
    expect((await GET(request('', undefined, { host: 'example.com' }))).status).toBe(403)
    expect((await GET(request('', undefined, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    expect(calls).toEqual([])
})

test('the mark-read deadline cancels stalled engine reads without acknowledging, and a later retry recovers', async () => {
    const q1 = await questionId(), a1 = await approvalId(), b1 = (await questionResolvers.readDesktopQuestion(runtime, bobChat.id)).question!.id
    for (const id of histories.keys()) stalled.add(id)
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    calls.length = 0
    const pending = mark([
        { id: q1, kind: 'question', agentId: alice.id, sessionId: question.id },
        { id: a1, kind: 'approval', agentId: alice.id, sessionId: approval.id },
        { id: b1, kind: 'question', agentId: bob.id, sessionId: bobChat.id },
    ])
    try {
        await vi.waitFor(() => expect(calls).toHaveLength(3))
        expect(timeout).toHaveBeenCalledExactlyOnceWith(2_500)
        controller.abort(new DOMException('Pending-inbox deadline', 'TimeoutError'))
        const response = await pending
        expect(response.status).toBe(200)
        const body = await response.json() as { marked: number; failedIds: string[] }
        expect(body.marked).toBe(0)
        expect(body.failedIds.slice().sort()).toEqual([q1, a1, b1].sort())
        expect(await seen()).toEqual([])
    } finally {
        controller.abort(); timeout.mockRestore(); stalled.clear()
    }
    expect(await (await mark([{ id: q1, kind: 'question', agentId: alice.id, sessionId: question.id }])).json()).toEqual({ marked: 1, failedIds: [] })
    expect((await read()).items.map(item => item.sessionId)).toEqual([approval.id, bobChat.id])
})

test('a later timeout in the same chat does not report an already confirmed receipt as failed', async () => {
    const q1 = await questionId()
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const originalRead = questionResolvers.readDesktopQuestion
    const reader = vi.spyOn(questionResolvers, 'readDesktopQuestion')
        .mockImplementationOnce(originalRead)
        .mockImplementationOnce(async (_runtime, _sessionId, options) => {
            const signal = options!.signal!
            return new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
        })
    const pending = mark([
        { id: q1, kind: 'question', agentId: alice.id, sessionId: question.id },
        { id: 'stale-request-in-the-same-chat', kind: 'question', agentId: alice.id, sessionId: question.id },
    ])
    try {
        await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
        controller.abort(new DOMException('Pending-inbox deadline', 'TimeoutError'))
        expect(await (await pending).json()).toEqual({ marked: 1, failedIds: ['stale-request-in-the-same-chat'] })
        expect((await seen()).map(row => String(row.item_id))).toEqual([q1])
    } finally {
        controller.abort(); timeout.mockRestore(); reader.mockRestore()
    }
})

test('a resolver finishing after the deadline cannot create a read receipt', async () => {
    const q1 = await questionId()
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const originalRead = questionResolvers.readDesktopQuestion
    const reader = vi.spyOn(questionResolvers, 'readDesktopQuestion').mockImplementationOnce(async (...args) => {
        const result = await originalRead(...args)
        // Model the deadline expiring after history arrived, while local receipt reads finish.
        controller.abort(new DOMException('Pending-inbox deadline', 'TimeoutError'))
        return result
    })
    try {
        expect(await (await mark([{ id: q1, kind: 'question', agentId: alice.id, sessionId: question.id }])).json()).toEqual({ marked: 0, failedIds: [q1] })
        expect(await seen()).toEqual([])
    } finally {
        controller.abort(); timeout.mockRestore(); reader.mockRestore()
    }
})
