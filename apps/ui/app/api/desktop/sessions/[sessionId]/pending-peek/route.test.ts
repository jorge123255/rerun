import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Message } from '@rerun/contracts'
import { desktopPendingPeekSchema } from '@/lib/desktop/pending-peek'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopApproval } from '@/lib/desktop/server/approvals'
import { readDesktopQuestion } from '@/lib/desktop/server/questions'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import { GET } from './route'

// The inbox peek on the Mac (upstream #272): one conversation's pending question or approval with
// the coworker's words around it, read without answering, marking read or writing anything.
const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent
const histories = new Map<string, { owner: string; rows: Message[] }>(), calls: string[] = []
const time = '2026-11-17T10:00:00.000Z'
const row = (sessionId: string, id: string, role: Message['role'], parts: unknown[]): Message => ({ id: `${sessionId}-${id}`, sessionId, role, contentJson: JSON.stringify(parts), toolCallsJson: null, createdAt: time })
const text = (value: string) => ({ type: 'text', text: value })
function waiting(sessionId: string, toolName: 'ask_user' | 'request_approval', input: unknown, lead: string[]): Message[] {
    const toolCallId = `${sessionId}-call`
    return [
        row(sessionId, 'user', 'user', [text('Follow up on my deals')]),
        row(sessionId, 'request', 'assistant', [...lead.map(text), { type: 'tool-call', toolName, toolCallId, input }]),
        row(sessionId, 'result', 'tool', [{ type: 'tool-result', toolName, toolCallId, output: { type: 'json', value: { status: 'delivered' } } }]),
    ]
}
function request(sessionId: string, cookie = true) {
    return new Request(`${runtime.app.origin}/api/desktop/sessions/${sessionId}/pending-peek`, {
        headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin, ...(cookie && { cookie: `rerun-desktop-session=${runtime.app.sessionToken}` }) },
    })
}
const peek = (sessionId: string, cookie = true) => GET(request(sessionId, cookie), { params: Promise.resolve({ sessionId }) })
async function seed(engineId: string, rows: Message[]): Promise<DesktopSession> {
    const session = await createDesktopSession(await openDesktopDatabase(root), { agentId: alice.id, engineSessionId: engineId, title: 'Chat ' + engineId })
    histories.set(engineId, { owner: alice.engineAgentId, rows })
    return session
}
const count = async (table: string) => Number((await (await openDesktopDatabase(root)).execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n)

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-pending-peek-api-'))
    histories.clear(); calls.length = 0
    server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`)
        const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        const history = req.url?.match(/^\/agents\/([^/]+)\/sessions\/([^/?]+)\/messages/)
        const found = history && histories.get(history[2]!)
        if (req.method === 'GET' && history) return reply(found?.owner === history[1] ? 200 : 404, found?.owner === history[1] ? { messages: found.rows } : { error: 'Not found' })
        return reply(404, { error: 'Unexpected fixture request' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'pending-peek-api', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3197', sessionToken: 'a'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    alice = await createDesktopAgent(await openDesktopDatabase(root), { name: 'Alice', engineAgentId: 'engine-alice' })
})

afterEach(async () => {
    await closeDesktopDatabase(root)
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    await rm(root, { recursive: true, force: true })
})

test('reads the question a conversation waits on with the words around it, and writes nothing', async () => {
    const questions = [{ question: 'How should the follow-ups sound?', options: ['Friendly', 'Formal'] }]
    const session = await seed('asks', waiting('asks', 'ask_user', { questions }, ['I drafted 23 follow-ups.', 'One thing about your tone first.']))
    const response = await peek(session.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = desktopPendingPeekSchema.parse(await response.json())
    // The same request, by the same id, as the chat card reads.
    expect(body.question).toEqual((await readDesktopQuestion(runtime, session.id)).question)
    expect(body.question?.questions).toEqual([{ ...questions[0], multiple: false }])
    expect(body.approval).toBeNull()
    expect(body.ask).toBe('One thing about your tone first.')
    expect(body.before).toBe('I drafted 23 follow-ups.')
    // Reading is not answering and not marking read: no receipt of either kind exists.
    expect(await count('desktop_question_answers')).toBe(0)
    expect(await count('desktop_approval_answers')).toBe(0)
    expect(calls.every(call => call.startsWith('GET '))).toBe(true)
})

test('one transcript read serves the question, the approval and the context', async () => {
    const session = await seed('asks', waiting('asks', 'ask_user', { questions: [{ question: 'Which?', options: ['A', 'B'] }] }, ['Pick one.']))
    calls.length = 0
    await peek(session.id)
    expect(calls.filter(call => call.includes('/messages'))).toHaveLength(1)
})

test('reads an approval the same way', async () => {
    const approvals = [{ action: 'Send to lena@northwind.example', detail: 'Subject: Following up' }]
    const session = await seed('approves', waiting('approves', 'request_approval', { approvals }, ['Before anything leaves:']))
    const body = desktopPendingPeekSchema.parse(await (await peek(session.id)).json())
    expect(body.approval).toEqual((await readDesktopApproval(runtime, session.id)).approval)
    expect(body.approval?.approvals).toEqual(approvals)
    expect(body.question).toBeNull()
    expect(body.ask).toBe('Before anything leaves:')
    expect(body.before).toBeNull()
})

test('a conversation that waits on nothing reads as neither', async () => {
    const session = await seed('quiet', [row('quiet', 'user', 'user', [text('Hi')]), row('quiet', 'reply', 'assistant', [text('Hello!')])])
    expect(desktopPendingPeekSchema.parse(await (await peek(session.id)).json())).toEqual({ question: null, approval: null, ask: '', before: null })
})

test('an unknown conversation and a request without the app session are refused', async () => {
    expect((await peek('00000000-0000-4000-8000-000000000000')).status).toBe(404)
    const session = await seed('asks', waiting('asks', 'ask_user', { questions: [{ question: 'Which?', options: ['A', 'B'] }] }, ['Pick one.']))
    const refused = await peek(session.id, false)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(calls.filter(call => call.includes('/messages'))).toHaveLength(0)
})
