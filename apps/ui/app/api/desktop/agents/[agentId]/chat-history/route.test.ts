import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { findDesktopApproval, findDesktopQuestion, type Message, type Session, type SessionSource } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import { readDesktopAttention } from '@/lib/desktop/server/attention'
import { readDesktopApproval } from '@/lib/desktop/server/approvals'
import { readDesktopQuestion } from '@/lib/desktop/server/questions'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET } from './route'

vi.mock('@/lib/desktop/server/secret-requests/binding', () => ({ readDesktopSecretRequestView: async () => ({ request: null }) }))
vi.mock('@/lib/desktop/server/service-requests/view', () => ({ readDesktopServiceRequestView: async () => ({ request: null }) }))
vi.mock('@/lib/desktop/server/mcp-sign-in/binding', () => ({ readDesktopMcpSignInView: async () => ({ request: null }) }))
vi.mock('@/lib/desktop/server/tool-install/runtime', () => ({ readDesktopToolInstallHistory: async () => [] }))

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent
let question: DesktopSession, approval: DesktopSession, acceptedQuestion: DesktopSession, acceptedApproval: DesktopSession, bobChat: DesktopSession
let failSessions = false
const time = '2026-11-03T12:00:00.000Z'
const remoteSessions: Session[] = [], histories = new Map<string, Message[]>(), calls: string[] = [], failedHistories = new Set<string>()

function rows(sessionId: string, kind: 'question' | 'approval' | 'takeover'): Message[] {
    const forms = {
        question: { toolName: 'ask_user', input: { questions: [{ question: 'Which color should I use?' }] } },
        approval: { toolName: 'request_approval', input: { approvals: [{ action: 'Use the orange heading', detail: 'Keep the blue heading.' }] } },
        takeover: { toolName: 'request_takeover', input: { url: 'http://127.0.0.1', reason: 'Finish the local browser step' } },
    }
    const { toolName, input } = forms[kind]
    return [
        { id: `${sessionId}-request`, sessionId, role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName, toolCallId: `${sessionId}-call`, input }]), toolCallsJson: null, createdAt: time },
        { id: `${sessionId}-result`, sessionId, role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolName, toolCallId: `${sessionId}-call`, output: { type: 'json', value: { status: 'delivered' } } }]), toolCallsJson: null, createdAt: time },
    ]
}
function request(agentId: string, cookie = runtime.app.sessionToken) {
    return new Request(`${runtime.app.origin}/api/desktop/agents/${agentId}/chat-history`, { headers: {
        host: new URL(runtime.app.origin).host, cookie: `rerun-desktop-session=${cookie}`,
    } })
}
const get = (agentId = alice.id) => GET(request(agentId), { params: Promise.resolve({ agentId }) })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-chat-filters-api-'))
    remoteSessions.length = 0; histories.clear(); calls.length = 0; failedHistories.clear(); failSessions = false
    server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`)
        const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        const listing = req.url?.match(/^\/agents\/([^/]+)\/sessions$/)
        if (req.method === 'GET' && listing) return reply(failSessions ? 503 : 200, failSessions ? { error: 'Unavailable' } : { sessions: remoteSessions.filter(row => row.agentId === listing[1]) })
        const history = req.url?.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/)
        if (req.method === 'GET' && history) {
            if (failedHistories.has(history[2])) return reply(503, { error: 'Unavailable' })
            const owned = remoteSessions.some(row => row.id === history[2] && row.agentId === history[1])
            return reply(owned ? 200 : 404, owned ? { messages: histories.get(history[2]) ?? [] } : { error: 'Not found' })
        }
        return reply(404, { error: 'Unexpected fixture request' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: 'history-launch', buildId: 'history-api', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3197', sessionToken: 'a'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' })
    bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    const seed = async (owner: DesktopAgent, engineId: string, source: SessionSource, kind: 'question' | 'approval') => {
        const local = await createDesktopSession(db, { agentId: owner.id, engineSessionId: engineId, title: engineId })
        remoteSessions.push({ id: engineId, agentId: owner.engineAgentId, title: engineId, status: 'open', source, originAgentId: null, originSessionId: null, createdAt: time, updatedAt: time })
        histories.set(engineId, rows(engineId, kind))
        return local
    }
    question = await seed(alice, 'question', 'dashboard', 'question')
    approval = await seed(alice, 'approval', 'schedule', 'approval')
    acceptedQuestion = await seed(alice, 'accepted-question', 'api', 'question')
    acceptedApproval = await seed(alice, 'accepted-approval', 'trigger', 'approval')
    bobChat = await seed(bob, 'bob-question', 'dashboard', 'question')
    const q = (await readDesktopQuestion(runtime, acceptedQuestion.id)).question!
    const a = (await readDesktopApproval(runtime, acceptedApproval.id)).approval!
    const pendingQuestion = findDesktopQuestion(histories.get(acceptedQuestion.engineSessionId)!)!
    const pendingApproval = findDesktopApproval(histories.get(acceptedApproval.engineSessionId)!)!
    const questionGuard = { sourceMessageId: pendingQuestion.sourceMessageId, toolCallId: pendingQuestion.toolCallId, fingerprint: pendingQuestion.fingerprint }
    const approvalGuard = { sourceMessageId: pendingApproval.sourceMessageId, toolCallId: pendingApproval.toolCallId, fingerprint: pendingApproval.fingerprint }
    await db.execute({ sql: 'INSERT INTO desktop_question_answers (request_id,agent_id,session_id,question_id,question_guard,payload,answer_text,accepted,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [crypto.randomUUID(), alice.id, acceptedQuestion.id, q.id, JSON.stringify(questionGuard), '{"action":"cancel"}', 'Dismissed', 1, time] })
    await db.execute({ sql: 'INSERT INTO desktop_approval_answers (request_id,agent_id,session_id,approval_id,approval_guard,payload,answer_text,accepted,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [crypto.randomUUID(), alice.id, acceptedApproval.id, a.id, JSON.stringify(approvalGuard), '{"decisions":[{"decision":"declined"}]}', 'Declined', 1, time] })
    calls.length = 0
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('GET resolves questions and approvals while respecting accepted receipts, ownership and read-only access', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body.enrichment).toBe('ok')
    expect(body.questions).toBe('ok')
    expect(body.conversations).toHaveLength(4)
    expect(body.conversations.filter((row: { needsYou: boolean }) => row.needsYou).map((row: { id: string }) => row.id).sort()).toEqual([question.id, approval.id].sort())
    expect(body.conversations.find((row: { id: string }) => row.id === approval.id)).toMatchObject({ source: 'schedule', pendingQuestion: 'Use the orange heading' })
    expect(calls.every(call => call.startsWith('GET '))).toBe(true)
    expect(calls.some(call => call.includes('engine-bob'))).toBe(false)
    expect(calls.filter(call => call.endsWith('/messages')).sort()).toEqual([
        'GET /agents/engine-alice/sessions/accepted-approval/messages',
        'GET /agents/engine-alice/sessions/accepted-question/messages',
        'GET /agents/engine-alice/sessions/approval/messages',
        'GET /agents/engine-alice/sessions/question/messages',
    ])
    expect((await (await get(bob.id)).json()).conversations.map((row: { id: string }) => row.id)).toEqual([bobChat.id])
})

test('reopening the local database retains accepted request receipts and source classification', async () => {
    await closeDesktopDatabase(root)
    const body = await (await get()).json()
    expect(body.conversations.find((row: { id: string }) => row.id === acceptedQuestion.id)).toMatchObject({ needsYou: false, source: 'api' })
    expect(body.conversations.find((row: { id: string }) => row.id === acceptedApproval.id)).toMatchObject({ needsYou: false, source: 'trigger' })
})

test('failed classification and pending reads stay distinct from empty results and can recover', async () => {
    failSessions = true; failedHistories.add(question.engineSessionId)
    let body = await (await get()).json()
    expect(body).toMatchObject({ enrichment: 'unavailable', questions: 'unavailable' })
    expect(body.conversations).toHaveLength(4)
    expect(body.conversations.find((row: { id: string }) => row.id === approval.id).needsYou).toBe(true)
    failSessions = false; failedHistories.clear()
    body = await (await get()).json()
    expect(body).toMatchObject({ enrichment: 'ok', questions: 'ok' })
    expect(body.conversations.filter((row: { needsYou: boolean }) => row.needsYou)).toHaveLength(2)
})

test('foreign history cannot label a selected coworker and unauthenticated callers cannot list chats', async () => {
    histories.set(question.engineSessionId, rows(bobChat.engineSessionId, 'question'))
    const body = await (await get()).json()
    expect(body.questions).toBe('unavailable')
    expect(body.conversations.find((row: { id: string }) => row.id === question.id).needsYou).toBe(false)
    expect((await GET(request(alice.id, 'wrong'), { params: Promise.resolve({ agentId: alice.id }) })).status).toBe(401)
    expect((await get('missing')).status).toBe(404)
})

test('a fresh history read observes changed forms without reusing the previous transcript', async () => {
    expect((await (await get()).json()).conversations.find((row: { id: string }) => row.id === question.id).needsYou).toBe(true)
    histories.set(question.engineSessionId, [])
    calls.length = 0
    const body = await (await get()).json()
    expect(body.conversations.find((row: { id: string }) => row.id === question.id)).toMatchObject({ needsYou: false, pendingQuestion: null })
    expect(calls.filter(call => call.endsWith('/sessions/question/messages'))).toHaveLength(1)
})

test('board attention shares a transcript for the takeover fallback and still honors a Stop receipt', async () => {
    histories.set(approval.engineSessionId, rows(approval.engineSessionId, 'takeover'))
    const initial = await readDesktopAttention(runtime)
    expect(initial.unavailableAgentIds).toEqual([])
    expect(initial.items.find(item => item.sessionId === approval.id)).toMatchObject({ kind: 'takeover', summary: 'Finish the local browser step' })
    expect(calls.filter(call => call.endsWith('/sessions/approval/messages'))).toHaveLength(1)

    const db = await openDesktopDatabase(root)
    await db.execute({
        sql: `INSERT INTO desktop_trigger_request_links_v1
            (link_key,workspace_id,agent_id,session_id,event_id,source_run_id,source_json,continuation_id,phase,created_at,updated_at)
            VALUES ('fixture-link','1',?,?,'fixture-event','fixture-run',?,'fixture-continuation','stopped',?,?)`,
        args: [alice.id, approval.id, JSON.stringify({ sourceMessageId: `${approval.engineSessionId}-request` }), time, time],
    })
    const afterStop = await readDesktopAttention(runtime)
    expect(afterStop.unavailableAgentIds).toEqual([])
    expect(afterStop.items.some(item => item.sessionId === approval.id)).toBe(false)
    expect(afterStop.items.some(item => item.sessionId === question.id)).toBe(true)
})
