import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { findDesktopApproval, serializeApprovalDecisions, type Message } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '@/lib/desktop/server/store'
import type { DesktopPendingApproval, DesktopApprovalAnswer } from '@/lib/desktop/approvals'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET, POST } from './route'

const originalEnv = { ...process.env }
let root: string, server: Server, runtime: DesktopRuntime, alice: DesktopAgent, bob: DesktopAgent, a: DesktopSession, b: DesktopSession
let rejectBeforeAccept: boolean, foreignHistory: boolean, historyReads: number, modelReads: number
const histories = new Map<string, Message[]>(), receipts = new Map<string, string>(), dispatches: Record<string, unknown>[] = []
const approvals = [
    { action: 'Prepare a draft', detail: 'Keep it in this chat.' },
    { action: 'Send the draft', detail: 'Would contact an external recipient.' },
    { action: 'Remove the source file' },
]
const decisions: DesktopApprovalAnswer['decisions'] = [{ decision: 'approved' }, { decision: 'declined', note: '  Keep it local.  ' }, { decision: 'declined', note: '   ' }]
const canonical: DesktopApprovalAnswer['decisions'] = [{ decision: 'approved' }, { decision: 'declined', note: 'Keep it local.' }, { decision: 'declined' }]

function message(sessionId: string, role: Message['role'], content: unknown, id = crypto.randomUUID()): Message {
    return { id, sessionId, role, contentJson: JSON.stringify(content), toolCallsJson: null, sourcesJson: null, createdAt: new Date().toISOString(), authorId: null }
}
function approvalRows(sessionId: string, name = 'request_approval', callId = 'approval-call', input: unknown = { approvals }) {
    return [message(sessionId, 'assistant', [{ type: 'text', text: 'Please review these actions.' }, { type: 'tool-call', toolName: name, toolCallId: callId, input }]),
        message(sessionId, 'tool', [{ type: 'tool-result', toolName: name, toolCallId: callId, output: { type: 'json', value: { status: 'delivered' } } }])]
}
function request(sessionId: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const origin = runtime.app.origin
    return new Request(`${origin}/api/desktop/sessions/${sessionId}/approvals`, { method, headers: { host: new URL(origin).host, origin,
        cookie: 'rerun-desktop-session=' + runtime.app.sessionToken, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const get = (sessionId = a.id) => GET(request(sessionId), { params: Promise.resolve({ sessionId }) })
const post = (body: unknown, sessionId = a.id, headers?: Record<string, string>) => POST(request(sessionId, 'POST', body, headers), { params: Promise.resolve({ sessionId }) })
const pending = async (sessionId = a.id) => (await (await get(sessionId)).json()).approval as DesktopPendingApproval
const answer = (approval: DesktopPendingApproval, values = decisions): DesktopApprovalAnswer => ({ approvalId: approval.id, requestId: crypto.randomUUID(), decisions: values })

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-approval-api-'))
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
            const identity = JSON.stringify([chat[1], body.sessionId, body.message, turn?.approval])
            if (receipts.has(turn?.runId)) {
                if (receipts.get(turn.runId) !== identity) return reply(409, { error: 'Different queued message' })
                return res.writeHead(204, { 'x-session-id': body.sessionId, 'x-run-id': turn.runId }).end()
            }
            if (turn?.replayOnly) return reply(404, { code: 'queued_turn_not_found' })
            dispatches.push(body)
            if (rejectBeforeAccept) return reply(503, { error: 'Provider unavailable' })
            const approval = findDesktopApproval(histories.get(body.sessionId) ?? [])
            if (!approval || approval.sourceMessageId !== turn?.approval?.sourceMessageId || approval.toolCallId !== turn.approval.toolCallId || approval.fingerprint !== turn.approval.fingerprint) return reply(409, { error: 'Approval is stale' })
            receipts.set(turn.runId, identity)
            histories.get(body.sessionId)!.push(message(body.sessionId, 'user', [{ type: 'text', text: body.message }]))
            return res.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId, 'x-run-id': turn.runId }).end('data: [DONE]\n\n')
        }
        reply(404, { error: 'Missing fixture route' })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    runtime = { protocolVersion: 1, launchNonce: 'approval-launch', buildId: 'approval-api', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3197', sessionToken: 'a'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: 'engine-alice' }); bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    a = await createDesktopSession(db, { agentId: alice.id, engineSessionId: 'engine-a', title: 'Alice chat', model: { connectionId: 'provider', model: 'chat-model' } })
    b = await createDesktopSession(db, { agentId: bob.id, engineSessionId: 'engine-b', title: 'Bob chat' })
    histories.set('engine-a', approvalRows('engine-a')); histories.set('engine-b', approvalRows('engine-b'))
})
afterEach(async () => {
    await closeDesktopDatabase(root); process.env = { ...originalEnv }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
})

test('GET is read-only and returns only a delivered, owned saved approval with its complete actions', async () => {
    const approval = await pending()
    expect(approval.approvals).toEqual(approvals)
    expect(approval.id).toMatch(/^[a-f0-9]{64}$/)
    expect(approval.id).not.toBe((await pending(b.id)).id)
    const db = await openDesktopDatabase(root)
    expect((await db.execute('SELECT * FROM desktop_approval_answers')).rows).toHaveLength(0)
    expect(dispatches).toHaveLength(0); expect(modelReads).toBe(0)
    histories.set('engine-a', approvalRows('engine-a', 'ask_user', 'question', { questions: [{ question: 'Anything?' }] }))
    expect(await pending()).toBeNull()
    histories.set('engine-a', approvalRows('engine-a'))
    histories.get('engine-a')![1].contentJson = JSON.stringify([{ type: 'tool-result', toolCallId: 'approval-call', output: { type: 'error-text', value: 'Rejected' } }])
    expect(await pending()).toBeNull()
    foreignHistory = true
    expect((await get()).status).toBe(502)
})

test('auth and strict decision input reject client-authored actions, approval notes, extra fields and foreign identity', async () => {
    const approval = await pending(), body = answer(approval)
    expect((await post(body, a.id, { cookie: '' })).status).toBe(401)
    expect((await post(body, a.id, { origin: 'https://example.com' })).status).toBe(403)
    for (const extra of [{ agentId: bob.id }, { attachmentPath: 'secret.md' }, { action: 'cancel' }, { approvals }]) expect((await post({ ...body, ...extra })).status).toBe(400)
    expect((await post({ ...body, decisions: [{ decision: 'approved', action: 'Forged action' }, ...decisions.slice(1)] })).status).toBe(400)
    expect((await post({ ...body, decisions: [{ decision: 'approved', note: '' }, ...decisions.slice(1)] })).status).toBe(400)
    expect((await post({ ...body, decisions: [{ decision: 'declined', detail: 'Forged detail' }, ...decisions.slice(1)] })).status).toBe(400)
    expect((await post({ ...body, decisions: [{ decision: 'approved' }] })).status).toBe(400)
    expect((await post({ ...body, decisions: [...decisions, { decision: 'declined' }] })).status).toBe(400)
    expect((await post({ ...body, decisions: [{ decision: 'approved' }, { decision: 'declined', note: 'a'.repeat(10001) }, { decision: 'declined', note: 'b'.repeat(10000) }] })).status).toBe(400)
    expect((await post({ ...body, approvalId: '0'.repeat(64) })).status).toBe(409)
    expect((await post(body, b.id)).status).toBe(409)
    expect((await post(body, 'missing')).status).toBe(404)
    expect(dispatches).toHaveLength(0)
})

test('mixed decisions serialize authoritative actions and trimmed reasons using the conversation model without granting tools', async () => {
    const approval = await pending(), body = answer(approval)
    const response = await post(body)
    expect(response.status).toBe(200); expect(response.headers.get('x-approval-id')).toBe(approval.id)
    expect(response.headers.get('x-session-id')).toBe(a.id); expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].message).toBe(serializeApprovalDecisions(approvals.map((item, index) => ({ ...item, ...canonical[index] }))))
    expect(dispatches[0]).toMatchObject({ connectionId: 'provider', model: 'chat-model', sessionId: 'engine-a', desktopQueuedTurn: { runId: body.requestId, approval: { sourceMessageId: approval.messageId, toolCallId: approval.toolCallId } } })
    expect(dispatches[0]).not.toHaveProperty('workspaceAttachment')
    expect(dispatches[0]).not.toHaveProperty('tools')
    expect(dispatches[0].desktopQueuedTurn).not.toHaveProperty('question')
    expect(await pending()).toBeNull()
})

test('same decisions with fresh UUIDs share one canonical run; changed intent and UUID reuse cannot target a later batch or another chat', async () => {
    const approval = await pending(), first = answer(approval), second = answer(approval, canonical)
    const responses = await Promise.all([post(first), post(second)])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(new Set(responses.map(response => response.headers.get('x-run-id'))).size).toBe(1)
    const canonicalRun = responses[0].headers.get('x-run-id')
    expect(dispatches).toHaveLength(1)
    expect((await post(answer(approval, [{ decision: 'declined' }, ...canonical.slice(1)]))).status).toBe(409)
    expect((await post(answer(approval, [canonical[0], { decision: 'declined', note: 'Changed reason' }, canonical[2]]))).status).toBe(409)
    histories.get('engine-a')!.push(...approvalRows('engine-a', 'request_approval', 'approval-call', { approvals: [{ action: 'A later action' }] }))
    const later = await pending(); expect(later.id).not.toBe(approval.id)
    const reads = historyReads, models = modelReads
    const replay = await post(answer(approval))
    expect(replay.status).toBe(200); expect(replay.headers.get('x-run-id')).toBe(canonicalRun)
    expect(historyReads).toBe(reads); expect(modelReads).toBe(models); expect(dispatches).toHaveLength(1)
    expect((await post({ ...answer(later, [{ decision: 'approved' }]), requestId: second.requestId })).status).toBe(409)
    expect((await post({ ...answer(await pending(b.id)), requestId: second.requestId }, b.id)).status).toBe(409)
})

test('a lost local acknowledgement reconciles after cold restart and disable without another run or model lookup', async () => {
    const approval = await pending(), body = answer(approval), db = await openDesktopDatabase(root)
    await db.execute("CREATE TRIGGER lose_approval_ack BEFORE UPDATE OF accepted ON desktop_approval_answers BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END")
    expect((await post(body)).status).toBe(500)
    expect(dispatches).toHaveLength(1)
    await db.execute('DROP TRIGGER lose_approval_ack')
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [alice.id] })
    await closeDesktopDatabase(root)
    runtime.app.origin = 'http://127.0.0.1:3198'; runtime.launchNonce = 'restarted'
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    const reads = historyReads, models = modelReads
    const replay = await post(answer(approval))
    expect(replay.status).toBe(200); expect(replay.headers.get('x-run-id')).toBe(body.requestId)
    expect(dispatches).toHaveLength(1); expect(historyReads).toBe(reads); expect(modelReads).toBe(models)
    expect((await (await openDesktopDatabase(root)).execute('SELECT accepted FROM desktop_approval_answers')).rows[0].accepted).toBe(1)
})

test('unaccepted intent survives restart for review; later retry uses the original UUID and cannot silently change decisions', async () => {
    const approval = await pending(), body = answer(approval)
    rejectBeforeAccept = true
    expect((await post(body)).status).toBe(502)
    await closeDesktopDatabase(root)
    const restored = await pending()
    expect(restored.attempt).toEqual({ requestId: body.requestId, decisions: canonical })
    expect((await post(answer(approval, approvals.map(() => ({ decision: 'approved' }))))).status).toBe(409)
    rejectBeforeAccept = false
    const response = await post(answer(approval, canonical))
    expect(response.status).toBe(200); expect(response.headers.get('x-run-id')).toBe(body.requestId)
    expect(receipts.size).toBe(1)
})

test('an expired unaccepted intent and opposing simultaneous decisions cannot authorize a newer batch', async () => {
    const approval = await pending(), body = answer(approval)
    rejectBeforeAccept = true; expect((await post(body)).status).toBe(502); rejectBeforeAccept = false
    histories.get('engine-a')!.push(message('engine-a', 'user', 'Move on'), ...approvalRows('engine-a', 'request_approval', 'next-call', { approvals: [{ action: 'New action', detail: 'A different operation' }] }))
    expect((await post(body)).status).toBe(409); expect(receipts.size).toBe(0)
    const later = await pending()
    const approve = answer(later, [{ decision: 'approved' }]), decline = answer(later, [{ decision: 'declined', note: 'Do not proceed' }])
    const results = await Promise.all([post(approve), post(decline)])
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    const winning = results[0].status === 200 ? approve : decline
    expect(dispatches.at(-1)?.message).toBe(serializeApprovalDecisions([{ action: 'New action', detail: 'A different operation', ...winning.decisions[0] }]))
    expect(receipts.size).toBe(1)
})

test('legacy bridge approval input uses the original serializer and deleting its session cascades receipts only for that chat', async () => {
    histories.set('engine-a', approvalRows('engine-a', 'mcp__rerun__request_approval', 'legacy', { action: 'Legacy action', detail: 'Keep this detail' }))
    const approval = await pending(), body = answer(approval, [{ decision: 'declined' }])
    expect(approval.approvals).toEqual([{ action: 'Legacy action', detail: 'Keep this detail' }])
    expect((await post(body)).status).toBe(200)
    expect(dispatches[0].message).toBe(serializeApprovalDecisions([{ action: 'Legacy action', detail: 'Keep this detail', decision: 'declined' }]))
    const other = answer(await pending(b.id))
    expect((await post(other, b.id)).status).toBe(200)
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'DELETE FROM desktop_sessions WHERE id = ?', args: [a.id] })
    expect((await db.execute('SELECT request_id FROM desktop_approval_answers')).rows.map(row => row.request_id)).toEqual([other.requestId])
    expect((await db.execute('SELECT request_id FROM desktop_approval_requests')).rows.map(row => row.request_id)).toEqual([other.requestId])
    expect((await post(body)).status).toBe(404)
})
