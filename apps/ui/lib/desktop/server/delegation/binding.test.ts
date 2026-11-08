import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Allocation, EngineSource } from '../../../../../engine/src/desktop/delegation/protocol'
import type { Record as DelegationRecord, StopReceipt } from '../../../../../engine/src/desktop/delegation/types'
import type { DesktopRuntime } from '../runtime'

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), request: vi.fn() }))
vi.mock('../runtime', async importOriginal => ({ ...await importOriginal<typeof import('../runtime')>(), readDesktopRuntime: mocks.runtime }))
vi.mock('@/lib/engine/client', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/engine/client')>(), request: mocks.request }))

import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent, createDesktopSession } from '../store'
import { authorizeDelegationSource, handleDesktopDelegationBridge, handleDesktopDelegationManagement } from './binding'
import { delegationReceipts, delegationStore } from './store'
import { ensureForemanChat } from '../foreman/chat-store'
import { setDesktopWorkspaceFrozen } from '../workspace-admission'

let root: string
let runtime: DesktopRuntime
let db: Awaited<ReturnType<typeof openDesktopDatabase>>
let owner: Awaited<ReturnType<typeof createDesktopAgent>>
let session: Awaited<ReturnType<typeof createDesktopSession>>
let sibling: Awaited<ReturnType<typeof createDesktopSession>>
let engineAgent: { id: string; config: { enabled: boolean; ephemeral: boolean; tools: { desktopToolGrants: { delegate: boolean; webFetch: boolean } } } }
let engineSession: { id: string; agentId: string }
let engineRun: { id: string; agentId: string; sessionId: string; status: string }
const input: EngineSource = { engineAgentId: 'engine-owner', sessionId: 'engine-chat', runId: 'engine-run', toolCallId: 'delegate-tool' }

beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), 'rerun-delegation-binding-'))
    runtime = {
        protocolVersion: 1, workspaceId: 1, dataRoot: root, launchNonce: 'current-launch', buildId: 'binding-test',
        app: { origin: 'http://127.0.0.1:3001', sessionToken: 's'.repeat(48) }, engine: { origin: 'http://127.0.0.1:3002', apiKey: 'test-engine-key' },
    }
    mocks.runtime.mockImplementation(async () => runtime)
    db = await openDesktopDatabase(root)
    owner = await createDesktopAgent(db, { name: 'Owner', engineAgentId: input.engineAgentId })
    session = await createDesktopSession(db, { agentId: owner.id, engineSessionId: input.sessionId, title: 'Parent chat' })
    sibling = await createDesktopSession(db, { agentId: owner.id, engineSessionId: 'engine-sibling', title: 'Sibling chat' })
    engineAgent = { id: input.engineAgentId, config: { enabled: true, ephemeral: false, tools: { desktopToolGrants: { delegate: true, webFetch: true } } } }
    engineSession = { id: input.sessionId, agentId: input.engineAgentId }
    engineRun = { id: input.runId, agentId: input.engineAgentId, sessionId: input.sessionId, status: 'running' }
    mocks.request.mockImplementation(async (_connection: unknown, path: string, _options: unknown, parse: (value: unknown) => unknown) => {
        if (path === `/agents/${input.engineAgentId}`) return parse(engineAgent)
        if (path === `/agents/${input.engineAgentId}/sessions/${input.sessionId}`) return parse(engineSession)
        if (path === `/agents/${input.engineAgentId}/runs/${input.runId}`) return parse(engineRun)
        throw new Error(`Unexpected engine request ${path}`)
    })
})
afterEach(async () => { if (root) { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) } })

function record(parentSessionId = session.id): DelegationRecord {
    return {
        version: 1, digest: 'a'.repeat(64), resources: [null], outputs: [null],
        snapshot: {
            delegationId: crypto.randomUUID(), revision: crypto.randomUUID(), parentAgentId: owner.id, parentSessionId,
            parentRunId: input.runId, toolCallId: input.toolCallId,
            tasks: [{ taskId: crypto.randomUUID(), title: 'Review a note', status: 'queued', steps: 0, toolCalls: 0, failures: 0, calls: [], preview: '', cleanup: 'pending' }],
        },
    }
}
function browserRequest(method = 'GET', body?: unknown) {
    return new Request(`${runtime.app.origin}/api/desktop/sessions/${session.id}/delegation`, {
        method, headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
}
function bridgeRequest(operation: string, data: unknown, launchNonce = runtime.launchNonce) {
    return new Request(`${runtime.app.origin}/api/desktop/internal/delegation`, {
        method: 'POST', headers: { host: new URL(runtime.app.origin).host, authorization: `Bearer ${runtime.engine.apiKey}` },
        body: JSON.stringify({ launchNonce, operation, data }),
    })
}
const bridge = (operation: string, data: unknown) => handleDesktopDelegationBridge(bridgeRequest(operation, data))

test('source authority binds the exact local chat to the current engine run and inherited read-only grant', async () => {
    expect(await authorizeDelegationSource(runtime, db, input, new AbortController().signal)).toEqual({
        source: { parentAgentId: owner.id, parentSessionId: session.id, parentRunId: input.runId, toolCallId: input.toolCallId }, webFetch: true,
    })
    expect(mocks.request).toHaveBeenCalledTimes(3)
    expect(await delegationStore(db).list()).toEqual([])
})

test.each(['local disabled', 'engine disabled', 'delegate revoked', 'ephemeral', 'session owner', 'run owner', 'run session', 'run status'] as const)('refuses %s before allocating any work', async changed => {
    if (changed === 'local disabled') await db.execute({ sql: 'UPDATE desktop_agents SET enabled=0 WHERE id=?', args: [owner.id] })
    if (changed === 'engine disabled') engineAgent.config.enabled = false
    if (changed === 'delegate revoked') engineAgent.config.tools.desktopToolGrants.delegate = false
    if (changed === 'ephemeral') engineAgent.config.ephemeral = true
    if (changed === 'session owner') engineSession.agentId = 'other-engine'
    if (changed === 'run owner') engineRun.agentId = 'other-engine'
    if (changed === 'run session') engineRun.sessionId = sibling.engineSessionId
    if (changed === 'run status') engineRun.status = 'done'
    await expect(authorizeDelegationSource(runtime, db, input, new AbortController().signal)).rejects.toThrow()
    expect((await db.execute('SELECT * FROM desktop_delegation_resources')).rows).toEqual([])
})

test.each(['epoch', 'local session'] as const)('rechecks changed %s after reading the engine', async changed => {
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args)
        if (String(args[1]).includes('/runs/')) {
            if (changed === 'epoch') runtime = { ...runtime, launchNonce: 'next-launch' }
            else await db.execute({ sql: 'UPDATE desktop_sessions SET engine_session_id=? WHERE id=?', args: ['replacement-chat', session.id] })
        }
        return result
    })
    await expect(authorizeDelegationSource(runtime, db, input, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
})

test('a disabled coworker retains exact-chat history and can stop its existing task', async () => {
    const saved = record(), other = record(sibling.id)
    await delegationStore(db).reserve(saved); await delegationStore(db).reserve(other)
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled=0 WHERE id=?', args: [owner.id] })
    const history = await handleDesktopDelegationManagement(browserRequest(), session.id)
    expect(history.status).toBe(200)
    expect(await history.json()).toEqual({ delegations: [saved.snapshot] })
    const stop = { operation: 'stop-task', requestId: crypto.randomUUID(), delegationId: saved.snapshot.delegationId, taskId: saved.snapshot.tasks[0]!.taskId, expectedRevision: saved.snapshot.revision }
    mocks.request.mockImplementationOnce(async (_connection: unknown, path: string, options: { body: string }, parse: (value: unknown) => unknown) => {
        expect(path).toBe('/desktop/delegation/stop')
        expect(JSON.parse(options.body)).toEqual({ launchNonce: runtime.launchNonce, source: { parentAgentId: owner.id, parentSessionId: session.id }, request: stop })
        return parse({ delegation: saved.snapshot })
    })
    const stopped = await handleDesktopDelegationManagement(browserRequest('POST', stop), session.id)
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ delegation: saved.snapshot })
    expect(mocks.request).toHaveBeenCalledTimes(1)
})

test('browser requests cannot use the engine bridge and missing chats never reach Stop', async () => {
    const request = browserRequest('POST', { launchNonce: runtime.launchNonce, operation: 'record-read', data: {} })
    expect((await handleDesktopDelegationBridge(request)).status).toBe(401)
    expect((await handleDesktopDelegationManagement(browserRequest(), 'missing-chat')).status).toBe(409)
    expect(mocks.request).not.toHaveBeenCalled()
})

test('allocation is durable and unique for the exact queued source/task', async () => {
    const saved = record()
    await delegationStore(db).reserve(saved)
    const data = { source: { parentAgentId: owner.id, parentSessionId: session.id, parentRunId: input.runId, toolCallId: input.toolCallId }, taskId: saved.snapshot.tasks[0]!.taskId }
    const first = await bridge('allocate', data)
    expect(first.status).toBe(200)
    const allocation = (await first.json()).result as Allocation
    expect(allocation).toMatchObject({ phase: 'reserved', source: data.source, taskId: data.taskId, rootIdentity: null, sessionId: null, runId: null, manifest: null })
    expect(allocation.childAgentId).toMatch(/^delegate-/)
    expect(await (await bridge('allocate', data)).json()).toEqual({ result: allocation })
    await closeDesktopDatabase(root); db = await openDesktopDatabase(root)
    expect(await (await bridge('recover', data)).json()).toEqual({ result: allocation })
    expect((await db.execute('SELECT token FROM desktop_delegation_resources')).rows).toHaveLength(1)
    expect((await bridge('allocate', { ...data, taskId: crypto.randomUUID() })).status).toBe(409)
})

test('resource saves use exact identity and revision, preserve cleanup intent, and restrict retired epochs to draining', async () => {
    const saved = record()
    await delegationStore(db).reserve(saved)
    const source = { parentAgentId: owner.id, parentSessionId: session.id, parentRunId: input.runId, toolCallId: input.toolCallId }
    const allocated = (await (await bridge('allocate', { source, taskId: saved.snapshot.tasks[0]!.taskId })).json()).result as Allocation
    const created: Allocation = { ...allocated, revision: crypto.randomUUID(), phase: 'created', rootIdentity: '1:2', sessionId: 'private-session', manifest: [] }
    expect((await bridge('resource-save', { record: created, expectedRevision: allocated.revision })).status).toBe(200)
    for (const next of [
        { ...created, revision: crypto.randomUUID(), identity: 'different' },
        { ...created, revision: crypto.randomUUID(), rootIdentity: 'replaced-root' },
        { ...created, revision: crypto.randomUUID(), sessionId: 'replacement-session' },
        { ...created, revision: crypto.randomUUID(), phase: 'reserved' },
    ]) expect((await bridge('resource-save', { record: next, expectedRevision: created.revision })).status).toBe(409)
    expect((await bridge('resource-save', { record: { ...created, revision: crypto.randomUUID() }, expectedRevision: allocated.revision })).status).toBe(409)
    runtime = { ...runtime, launchNonce: 'restarted-launch' }
    expect((await bridge('resource-save', { record: { ...created, revision: crypto.randomUUID(), phase: 'running', runId: 'unexpected-replay' }, expectedRevision: created.revision })).status).toBe(409)
    const drained: Allocation = { ...created, revision: crypto.randomUUID(), phase: 'drained', cleanupStarted: true }
    expect((await bridge('resource-save', { record: drained, expectedRevision: created.revision })).status).toBe(200)
    expect((await bridge('resource-save', { record: { ...drained, revision: crypto.randomUUID(), cleanupStarted: false }, expectedRevision: drained.revision })).status).toBe(409)
    expect(await (await bridge('resource-read', { token: allocated.token })).json()).toEqual({ result: drained })
})

test('a request paused during body reading cannot reserve Stop after its launch retires', async () => {
    const saved = record()
    await delegationStore(db).reserve(saved)
    const receipt: StopReceipt = {
        digest: 'b'.repeat(64), source: { parentAgentId: owner.id, parentSessionId: session.id },
        request: { operation: 'stop-task', requestId: crypto.randomUUID(), delegationId: saved.snapshot.delegationId, taskId: saved.snapshot.tasks[0]!.taskId, expectedRevision: saved.snapshot.revision },
    }
    const oldRuntime = runtime
    let authenticated!: () => void
    const captured = new Promise<void>(resolve => { authenticated = resolve })
    mocks.runtime.mockImplementationOnce(async () => { authenticated(); return oldRuntime })
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const incoming = new Request(`${oldRuntime.app.origin}/api/desktop/internal/delegation`, {
        method: 'POST', headers: { host: new URL(oldRuntime.app.origin).host, authorization: `Bearer ${oldRuntime.engine.apiKey}` }, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const pending = handleDesktopDelegationBridge(incoming)
    await captured
    runtime = { ...runtime, launchNonce: 'restarted-launch' }
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ launchNonce: oldRuntime.launchNonce, operation: 'stop-reserve', data: { requestId: receipt.request.requestId, receipt } })))
    controller.close()
    expect((await pending).status).toBe(409)
    expect(await delegationReceipts(db).read(receipt.request.requestId)).toBeNull()
    expect(await delegationStore(db).read(saved.snapshot.delegationId)).toEqual(saved)
})

test('progress may change the storage revision but cannot replace or remove a task Stop token', async () => {
    const saved = record()
    saved.snapshot.tasks[0]!.stopRevision = crypto.randomUUID()
    await delegationStore(db).reserve(saved)
    for (const token of [undefined, crypto.randomUUID()]) {
        const next = structuredClone(saved)
        next.snapshot.revision = crypto.randomUUID()
        next.snapshot.tasks[0]!.stopRevision = token
        expect((await bridge('record-save', { record: next, expectedRevision: saved.snapshot.revision })).status).toBe(409)
    }
    const next = structuredClone(saved)
    next.snapshot.revision = crypto.randomUUID()
    next.snapshot.tasks[0]!.preview = 'New text'
    expect((await bridge('record-save', { record: next, expectedRevision: saved.snapshot.revision })).status).toBe(200)
    expect(await delegationStore(db).read(saved.snapshot.delegationId)).toEqual(next)
})

test('Foreman delegates only from its current owned chat/run with the explicit grant', async () => {
    const owner = await ensureForemanChat(db, String(runtime.workspaceId))
    const source = { engineAgentId: 'foreman', sessionId: owner.sessionId, runId: crypto.randomUUID(), toolCallId: 'foreman-task' }
    const binding = { ...owner.chat, runId: source.runId, model: { connectionId: 'connection', model: 'model' } }
    const turn = { binding, sessionId: owner.sessionId, text: 'Review a note', brief: { instructions: 'Fixture', tools: [] } }
    await db.execute({ sql: "INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,'admitted',?)",
        args: [source.runId, owner.chat.chatId, 'digest', JSON.stringify(turn), new Date().toISOString()] })
    let grant = false
    mocks.request.mockImplementation(async (_connection: unknown, path: string, _options: unknown, parse: (value: unknown) => unknown) => {
        if (path === '/agents/foreman') return parse({ id: 'foreman', config: { kind: 'foreman', enabled: true, tools: { desktopToolGrants: { delegate: grant, webFetch: true } } } })
        if (path === `/agents/foreman/runs/${source.runId}`) return parse({ id: source.runId, agentId: 'foreman', sessionId: source.sessionId, status: 'running' })
        throw new Error(`Unexpected engine request ${path}`)
    })
    expect((await bridge('authority', source)).status).toBe(409)
    grant = true
    const bound = { parentAgentId: 'foreman', parentSessionId: owner.chat.chatId, parentRunId: source.runId, toolCallId: source.toolCallId }
    expect(await (await bridge('authority', source)).json()).toEqual({ result: { source: bound, webFetch: false } })
    expect((await bridge('authority', { ...source, sessionId: input.sessionId })).status).toBe(409)
    const saved = record(owner.chat.chatId)
    Object.assign(saved.snapshot, bound)
    expect((await bridge('record-reserve', saved)).status).toBe(200)
    const allocation = { source: bound, taskId: saved.snapshot.tasks[0]!.taskId }
    setDesktopWorkspaceFrozen(runtime, true)
    try { expect((await bridge('allocate', allocation)).status).toBe(409) }
    finally { setDesktopWorkspaceFrozen(runtime, false) }
    expect((await bridge('allocate', { ...allocation, source: { ...bound, parentSessionId: session.id } })).status).toBe(404)
    grant = false
    expect((await bridge('allocate', allocation)).status).toBe(409)
    grant = true
    expect((await bridge('allocate', allocation)).status).toBe(200)
    expect((await db.execute('SELECT * FROM desktop_delegation_resources')).rows).toHaveLength(1)
})
