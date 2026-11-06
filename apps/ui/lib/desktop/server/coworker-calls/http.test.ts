import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ setup: vi.fn(), model: vi.fn(), question: vi.fn(), approval: vi.fn(), takeover: vi.fn(), service: vi.fn(), secret: vi.fn(), getSession: vi.fn() }))
vi.mock('@/lib/engine/client', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/engine/client')>(), getSession: mocks.getSession }))
vi.mock('../setup/service', () => ({ assertDesktopSetupChatAllowed: mocks.setup }))
vi.mock('../chat-model', () => ({ resolveDesktopChatModel: mocks.model }))
vi.mock('../questions', () => ({ readDesktopQuestion: mocks.question }))
vi.mock('../approvals', () => ({ readDesktopApproval: mocks.approval }))
vi.mock('../takeover', () => ({ readDesktopTakeover: mocks.takeover }))
vi.mock('../service-requests/view', () => ({ readPendingDesktopServiceToolCallView: mocks.service }))
vi.mock('../secret-requests/binding', () => ({ readDesktopSecretRequestView: mocks.secret }))

import { DesktopHttpError } from '../auth'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { createDesktopAgent, createDesktopSession, listDesktopSessions } from '../store'
import { replaceDesktopCoworkerCallAllows } from './authority'
import { adoptDesktopCoworkerCallEpoch, getDesktopCoworkerCall, initializeDesktopCoworkerCalls, insertDesktopCoworkerCall, patchDesktopCoworkerCall, type CoworkerCallRecord } from './db'
import { handleDesktopCoworkerCallBridge, readDesktopCoworkerCalls, stopDesktopCoworkerCall } from './http'
import type { DesktopQuestionView } from '../../questions'
import type { DesktopApprovalView } from '../../approvals'
import type { DesktopTakeoverView } from '../../takeover'

const EPOCH = 'current-epoch'
const NOW = '2026-11-05T00:00:00.000Z'
const caller = { engineAgentId: 'engine-ann', engineSessionId: 'engine-parent-session', engineRunId: 'engine-parent-run' }
const choice = { connectionId: 'target-connection', model: 'target-model', source: 'coworker' as const }
let root: string
let runtime: DesktopRuntime
let db: Awaited<ReturnType<typeof openDesktopDatabase>>
let ann: Awaited<ReturnType<typeof createDesktopAgent>>
let bob: Awaited<ReturnType<typeof createDesktopAgent>>
let parentSession: Awaited<ReturnType<typeof createDesktopSession>>
let grant: boolean
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>

function envelope(op: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return { event: 'desktop.coworker-call', launchNonce: runtime.launchNonce, epoch: EPOCH, op, payload, ...overrides }
}

function targetPayload() {
    return { caller, target: { publicAgentId: bob.id, engineAgentId: bob.engineAgentId } }
}

async function bridge(body = envelope('prepare-target', targetPayload()), owner = runtime): Promise<Response> {
    const response = await handleDesktopCoworkerCallBridge(owner, body, fetcher)
    if (!response) throw new Error('The coworker-call bridge did not handle its event')
    return response
}

async function noChildEffects() {
    expect(await listDesktopSessions(db, bob.id)).toEqual([])
    expect((await db.execute('SELECT call_id FROM desktop_coworker_calls')).rows).toEqual([])
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
}

beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), 'rerun-coworker-bridge-'))
    runtime = {
        protocolVersion: 1, workspaceId: 1, dataRoot: root, launchNonce: 'current-launch', buildId: 'bridge-test',
        app: { origin: 'http://127.0.0.1:3001', sessionToken: 's'.repeat(48) },
        engine: { origin: 'http://127.0.0.1:3002', apiKey: 'fixture-engine-key' },
    }
    db = await openDesktopDatabase(root)
    await initializeDesktopCoworkerCalls(db)
    await adoptDesktopCoworkerCallEpoch(db, EPOCH, NOW, runtime.launchNonce)
    ann = await createDesktopAgent(db, { name: 'Ann', engineAgentId: caller.engineAgentId })
    bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: 'engine-bob' })
    parentSession = await createDesktopSession(db, { agentId: ann.id, engineSessionId: caller.engineSessionId, title: 'Caller chat' })
    await replaceDesktopCoworkerCallAllows(db, ann.id, [bob.id])
    grant = true
    fetcher = vi.fn<typeof fetch>(async (input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${runtime.engine.apiKey}`)
        expect(init?.method ?? 'GET').toBe('GET')
        const path = new URL(String(input)).pathname
        if (path === `/agents/${caller.engineAgentId}`) return Response.json({
            id: caller.engineAgentId, config: { enabled: true, tools: { callAgent: true, desktopToolGrants: { callAgent: grant } } },
        })
        if (path === `/agents/${caller.engineAgentId}/sessions/${caller.engineSessionId}`) {
            return Response.json({ id: caller.engineSessionId, agentId: caller.engineAgentId })
        }
        if (path === `/agents/${caller.engineAgentId}/runs/${caller.engineRunId}`) {
            return Response.json({ id: caller.engineRunId, agentId: caller.engineAgentId, sessionId: caller.engineSessionId, status: 'running' })
        }
        throw new Error(`Unexpected engine request: ${path}`)
    })
    mocks.setup.mockResolvedValue(undefined)
    mocks.model.mockResolvedValue(choice)
    mocks.question.mockResolvedValue({ question: null })
    mocks.approval.mockResolvedValue({ approval: null })
    mocks.takeover.mockResolvedValue({ takeover: null })
    mocks.service.mockResolvedValue(null)
    mocks.secret.mockResolvedValue({ request: null })
    mocks.getSession.mockResolvedValue(null)
})

afterEach(async () => {
    if (root) {
        await closeDesktopDatabase(root)
        await rm(root, { recursive: true, force: true })
    }
})

test('prepares only the live allowed target with its exact selected model and no child effects', async () => {
    const response = await bridge()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, result: {
        publicAgentId: bob.id, engineAgentId: bob.engineAgentId, connectionId: choice.connectionId, model: choice.model,
    } })
    expect(mocks.setup).toHaveBeenCalledTimes(2)
    expect(mocks.setup).toHaveBeenNthCalledWith(1, runtime, bob.id)
    expect(mocks.setup).toHaveBeenNthCalledWith(2, runtime, bob.id)
    expect(mocks.model).toHaveBeenCalledExactlyOnceWith(runtime, expect.objectContaining({ id: bob.id, engineAgentId: bob.engineAgentId }), null)
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname).filter(path => path.endsWith(`/runs/${caller.engineRunId}`))).toHaveLength(2)
    await noChildEffects()
})

test('pending setup refuses before resolving a model or creating any child work', async () => {
    mocks.setup.mockRejectedValue(new DesktopHttpError(409, 'Finish this coworker’s setup before chatting.'))
    const response = await bridge()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: 'Finish this coworker’s setup before chatting.' })
    expect(mocks.setup).toHaveBeenCalledExactlyOnceWith(runtime, bob.id)
    expect(mocks.model).not.toHaveBeenCalled()
    await noChildEffects()
})

test('an enabled target outside the caller’s allow-list is refused before setup or model selection', async () => {
    await replaceDesktopCoworkerCallAllows(db, ann.id, [])
    const response = await bridge()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: 'This coworker is not available for this call.' })
    expect(mocks.setup).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
    await noChildEffects()
})

test.each(['explicit Skip', 'completed setup'])('respects %s accepted by the existing setup gate', async state => {
    const order: string[] = []
    // The shared gate owns persisted Skip/completion semantics. The bridge must consult it
    // before model selection and again afterward, without starting or completing setup itself.
    mocks.setup.mockImplementation(async () => { order.push(`gate: ${state}`) })
    mocks.model.mockImplementation(async () => { order.push('resolve target model'); return choice })
    const response = await bridge()
    expect(response.status).toBe(200)
    expect(order).toEqual([`gate: ${state}`, 'resolve target model', `gate: ${state}`])
    await noChildEffects()
})

test.each(['before selection', 'during selection'])('rejects an exact target remap %s', async timing => {
    const body = envelope('prepare-target', targetPayload())
    const remap = () => db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id=? WHERE id=?', args: ['replacement-engine-bob', bob.id] })
    if (timing === 'before selection') await remap()
    else mocks.model.mockImplementation(async () => { await remap(); return choice })
    const response = await bridge(body)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: 'This coworker is not available for this call.' })
    expect(mocks.model).toHaveBeenCalledTimes(timing === 'before selection' ? 0 : 1)
    await noChildEffects()
})

test('an unavailable selected model propagates the strict resolver refusal without a fallback', async () => {
    const reason = 'This coworker’s default model is no longer available. Choose another model or follow the workspace default.'
    mocks.model.mockRejectedValue(new DesktopHttpError(409, reason))
    const response = await bridge()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: reason })
    expect(mocks.model).toHaveBeenCalledTimes(1)
    expect(mocks.setup).toHaveBeenCalledTimes(1)
    await noChildEffects()
})

test.each(['call grant', 'allowed target'])('rechecks a revoked %s after model selection', async revoked => {
    mocks.model.mockImplementation(async () => {
        if (revoked === 'call grant') grant = false
        else await replaceDesktopCoworkerCallAllows(db, ann.id, [])
        return choice
    })
    const response = await bridge()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: revoked === 'call grant'
        ? 'Call coworkers is turned off for this coworker.'
        : 'This coworker is not available for this call.' })
    expect(mocks.model).toHaveBeenCalledTimes(1)
    expect(mocks.setup).toHaveBeenCalledTimes(1)
    await noChildEffects()
})

test.each([
    { launchNonce: 'old-launch' },
    { launchNonce: undefined },
    { epoch: 'old-epoch' },
    { epoch: undefined },
])('rejects stale or missing runtime identity %j before authority, setup, or model effects', async identity => {
    const response = await bridge(envelope('prepare-target', targetPayload(), identity))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: 'The coworker call runtime has changed.' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.setup).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
    await noChildEffects()
})

test('cannot adopt a different epoch twice for the same app launch', async () => {
    const response = await bridge(envelope('adopt-epoch', { epoch: 'old-epoch', now: NOW }, { epoch: 'old-epoch' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: 'The coworker call runtime was already bound for this app launch.' })
    expect((await db.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id=1')).rows[0]?.epoch).toBe(EPOCH)
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.setup).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
})

test('rejects stale launch adoption and mismatched epoch envelopes without changing the active epoch', async () => {
    const stale = await bridge(envelope('adopt-epoch', { epoch: 'old-epoch', now: NOW }, { launchNonce: 'old-launch', epoch: 'old-epoch' }))
    expect(stale.status).toBe(409)
    const mismatched = await bridge(envelope('adopt-epoch', { epoch: 'different-payload-epoch', now: NOW }))
    expect(mismatched.status).toBe(400)
    expect((await db.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id=1')).rows[0]?.epoch).toBe(EPOCH)
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.setup).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
})

test('an old request that captured its runtime before restart cannot roll back the new adoption', async () => {
    const previousRuntime = runtime
    const delayedBody = envelope('adopt-epoch', { epoch: EPOCH, now: NOW })
    runtime = { ...runtime, launchNonce: 'next-launch' }
    const adopted = await bridge(envelope('adopt-epoch', { epoch: 'next-epoch', now: NOW }, { epoch: 'next-epoch' }))
    expect(adopted.status).toBe(200)
    // Authentication captures runtime before JSON parsing and bridge work. The old request
    // can therefore resume with its previously-valid runtime after the new bind completes.
    const delayed = await bridge(delayedBody, previousRuntime)
    expect(delayed.status).toBe(409)
    expect((await db.execute('SELECT epoch FROM desktop_coworker_call_epoch WHERE id=1')).rows[0]?.epoch).toBe('next-epoch')
    expect((await db.execute('SELECT launch_nonce FROM desktop_coworker_call_launch WHERE id=1')).rows[0]?.launch_nonce).toBe('next-launch')
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.setup).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
})

const PENDING_TOOL = 'child-human-request'
type PendingKind = 'question' | 'approval' | 'takeover' | 'service'

function pendingView(kind: PendingKind, toolCallId = PENDING_TOOL, accepted = false) {
    const identity = { id: 'a'.repeat(64), messageId: 'child-request-message', toolCallId, requestedAt: NOW }
    if (kind === 'question') mocks.question.mockResolvedValue({ question: {
        ...identity, questions: [{ question: 'Which file?', options: ['Report', 'Notes'] }],
    } } satisfies DesktopQuestionView)
    if (kind === 'approval') mocks.approval.mockResolvedValue({ approval: {
        ...identity, approvals: [{ action: 'Save the report' }],
    } } satisfies DesktopApprovalView)
    if (kind === 'takeover') mocks.takeover.mockResolvedValue({ takeover: {
        ...identity, url: 'https://example.test/sign-in', reason: 'Complete sign-in', opened: false,
    } } satisfies DesktopTakeoverView)
    // The read-only service projection returns null once the existing receipt is accepted.
    if (kind === 'service') mocks.service.mockResolvedValue(accepted ? null : toolCallId)
}

async function waitingCall(overrides: Partial<CoworkerCallRecord> = {}) {
    const target = await createDesktopSession(db, { agentId: bob.id, engineSessionId: 'engine-child-session', title: 'Called coworker chat' })
    const row: CoworkerCallRecord = {
        callId: crypto.randomUUID(), revision: 4,
        sourceKey: JSON.stringify([caller.engineAgentId, caller.engineSessionId, caller.engineRunId, 'parent-call-tool']),
        requestFingerprint: '0'.repeat(64), parentAgentId: ann.id, parentSessionId: parentSession.id,
        parentRunId: crypto.randomUUID(), toolCallId: 'parent-call-tool', targetAgentId: bob.id,
        targetSessionId: target.id, targetName: bob.name, wait: false, status: 'waiting-human', phase: 'terminal',
        launchEpoch: EPOCH, launchClaimed: true,
        engineParentAgentId: caller.engineAgentId, engineParentSessionId: caller.engineSessionId, engineParentRunId: caller.engineRunId,
        engineTargetAgentId: bob.engineAgentId, engineTargetSessionId: target.engineSessionId, engineChildRunId: 'finished-child-run',
        depth: 0, ancestors: [ann.id], progress: { steps: 1, toolCalls: 1, failures: 0, preview: 'Waiting for your answer', calls: [{ tool: 'ask_user', status: 'completed' }] },
        pendingToolCallId: PENDING_TOOL, resultText: 'Message dispatched to Bob.', error: null, stopRequestId: null,
        createdAt: NOW, updatedAt: NOW, ...overrides,
    }
    await insertDesktopCoworkerCall(db, row)
    return { row, target }
}

const pendingReaders = () => [mocks.question, mocks.approval, mocks.takeover, mocks.service]

async function expectUnchangedCall(row: CoworkerCallRecord) {
    expect(await getDesktopCoworkerCall(db, row.callId)).toEqual(row)
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.setup).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
}

test.each(['question', 'approval', 'takeover', 'service'] as const)('projects exact pending %s in the actual child chat as waiting without writes', async kind => {
    const { row, target } = await waitingCall()
    pendingView(kind)
    const before = (await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes
    const result = await readDesktopCoworkerCalls(runtime, parentSession.id)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]).toMatchObject({ callId: row.callId, status: 'waiting-human', revision: String(row.revision), targetSessionId: target.id })
    expect(result.calls[0]).not.toHaveProperty('pendingToolCallId')
    expect(result.calls[0]).not.toHaveProperty('engineChildRunId')
    expect((await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes).toBe(before)
    for (const reader of pendingReaders()) for (const args of reader.mock.calls) {
        expect(args).toEqual([runtime, target.id, { signal: expect.any(AbortSignal) }])
    }
    await expectUnchangedCall(row)
    expect((await db.execute('SELECT * FROM desktop_coworker_call_stop_intents')).rows).toEqual([])
    expect((await db.execute('SELECT * FROM desktop_coworker_call_stops')).rows).toEqual([])
})

test.each(['question', 'approval', 'takeover', 'service'] as const)('a later %s with a different tool-call identity does not keep the original call waiting', async kind => {
    const { row, target } = await waitingCall()
    pendingView(kind, 'later-unrelated-tool-call')
    const before = (await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes
    const result = await readDesktopCoworkerCalls(runtime, parentSession.id)
    expect(result.calls[0]).toMatchObject({ callId: row.callId, status: 'completed', revision: String(row.revision), targetSessionId: target.id })
    expect((await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes).toBe(before)
    await expectUnchangedCall(row)
})

test('an accepted service receipt completes the projection even while its exact source card remains visible', async () => {
    const { row } = await waitingCall()
    pendingView('service', PENDING_TOOL, true)
    const before = (await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0]?.status).toBe('completed')
    expect((await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes).toBe(before)
    await expectUnchangedCall(row)
})

test('accepted question/approval/takeover receipts exposed as no pending request complete the projection without rewriting history', async () => {
    const { row } = await waitingCall()
    // These existing readers return null for an accepted receipt, even if the source
    // request is still the last visible assistant message in the child chat.
    const before = (await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0]?.status).toBe('completed')
    expect((await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes).toBe(before)
    for (const reader of pendingReaders()) expect(reader).toHaveBeenCalledTimes(1)
    await expectUnchangedCall(row)
})

test.each(['another owner’s session', 'changed engine session', 'remapped target'] as const)('refuses a waiting projection with %s before reading pending requests', async mismatch => {
    const { row, target } = await waitingCall()
    if (mismatch === 'another owner’s session') await db.execute({ sql: 'UPDATE desktop_sessions SET agent_id=? WHERE id=?', args: [ann.id, target.id] })
    if (mismatch === 'changed engine session') await db.execute({ sql: 'UPDATE desktop_sessions SET engine_session_id=? WHERE id=?', args: ['replacement-engine-session', target.id] })
    if (mismatch === 'remapped target') await db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id=? WHERE id=?', args: ['replacement-engine-bob', bob.id] })
    const before = (await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes
    await expect(readDesktopCoworkerCalls(runtime, parentSession.id)).rejects.toMatchObject({ status: 409, message: 'The called conversation is no longer available.' })
    expect((await db.execute('SELECT total_changes() AS changes')).rows[0]?.changes).toBe(before)
    for (const reader of pendingReaders()) expect(reader).not.toHaveBeenCalled()
    await expectUnchangedCall(row)
})

test.each(['waiting', 'answered'] as const)('Stop on a terminal human request that is %s never cancels a child or a later run', async pending => {
    const { row } = await waitingCall()
    if (pending === 'waiting') pendingView('question')
    const input = { operation: 'stop', requestId: crypto.randomUUID(), callId: row.callId, expectedRevision: String(row.revision) }
    const response = await stopDesktopCoworkerCall(runtime, parentSession.id, input, fetcher)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.call).toMatchObject({ callId: row.callId, status: pending === 'waiting' ? 'waiting-human' : 'completed' })
    const replay = await stopDesktopCoworkerCall(runtime, parentSession.id, input, fetcher)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(body)
    await expectUnchangedCall(row)
    expect((await db.execute('SELECT request_id FROM desktop_coworker_call_stop_intents')).rows).toEqual([{ request_id: input.requestId }])
    expect((await db.execute('SELECT request_id FROM desktop_coworker_call_stops')).rows).toEqual([{ request_id: input.requestId }])
})

async function unlinkedCall(overrides: Partial<CoworkerCallRecord> = {}, keepLocalChat = false) {
    const saved = await waitingCall({ targetSessionId: null, status: 'error', pendingToolCallId: null, ...overrides })
    if (!keepLocalChat) await db.execute({ sql: 'DELETE FROM desktop_sessions WHERE id=?', args: [saved.target.id] })
    return saved
}

function actualCalledChat() {
    return {
        id: 'engine-child-session', agentId: bob.engineAgentId, title: 'Actual called chat', source: 'agent',
        originAgentId: caller.engineAgentId, originSessionId: caller.engineSessionId,
    }
}

test('reopens a retired call and durably links its exact existing engine chat without launching work', async () => {
    const { row } = await unlinkedCall({ status: 'running', phase: 'launched' })
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    runtime = { ...runtime, launchNonce: 'restarted-launch' }
    await adoptDesktopCoworkerCallEpoch(db, 'restarted-epoch', NOW, runtime.launchNonce)
    mocks.getSession.mockResolvedValue(actualCalledChat())

    const seen = (await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0]
    const chats = await listDesktopSessions(db, bob.id)
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ engineSessionId: row.engineTargetSessionId, title: 'Actual called chat' })
    expect(seen).toMatchObject({ status: 'interrupted', targetSessionId: chats[0].id, revision: String(row.revision + 2) })
    expect(await getDesktopCoworkerCall(db, row.callId)).toMatchObject({
        launchEpoch: EPOCH, status: 'interrupted', phase: 'terminal', engineChildRunId: row.engineChildRunId,
        targetSessionId: chats[0].id, progress: row.progress, resultText: row.resultText,
    })
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0]).toEqual(seen)
    expect(await listDesktopSessions(db, bob.id)).toHaveLength(1)
    expect(mocks.getSession).toHaveBeenCalledExactlyOnceWith(expect.any(Object), bob.engineAgentId, row.engineTargetSessionId, { signal: expect.any(AbortSignal) })
    expect(fetcher).not.toHaveBeenCalled()
    expect(mocks.setup).not.toHaveBeenCalled()
    expect(mocks.model).not.toHaveBeenCalled()
})

test('a lost local-link acknowledgement reuses the existing chat and writes the link once', async () => {
    const { row, target } = await unlinkedCall({}, true)
    mocks.getSession.mockResolvedValue(actualCalledChat())
    const seen = await readDesktopCoworkerCalls(runtime, parentSession.id)
    expect(seen.calls[0]).toMatchObject({ targetSessionId: target.id, revision: String(row.revision + 1) })
    expect(await readDesktopCoworkerCalls(runtime, parentSession.id)).toEqual(seen)
    expect(await listDesktopSessions(db, bob.id)).toHaveLength(1)
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
})

test.each(['missing', 'session', 'agent', 'source', 'origin agent', 'origin session'] as const)('does not recover a called chat with mismatched %s', async mismatch => {
    const { row } = await unlinkedCall()
    const actual = actualCalledChat()
    if (mismatch === 'session') actual.id = 'unrelated-chat'
    if (mismatch === 'agent') actual.agentId = caller.engineAgentId
    if (mismatch === 'source') actual.source = 'ui'
    if (mismatch === 'origin agent') actual.originAgentId = 'other-caller'
    if (mismatch === 'origin session') actual.originSessionId = 'other-parent-chat'
    mocks.getSession.mockResolvedValue(mismatch === 'missing' ? null : actual)
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0]).toMatchObject({ targetSessionId: null, revision: String(row.revision) })
    expect(await listDesktopSessions(db, bob.id)).toEqual([])
    await expectUnchangedCall(row)
})

test('an unavailable or malformed engine chat read leaves recovery retryable', async () => {
    const { row } = await unlinkedCall()
    mocks.getSession.mockRejectedValue(new Error('Engine response unavailable or invalid'))
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0]).toMatchObject({ targetSessionId: null, revision: String(row.revision) })
    expect(await listDesktopSessions(db, bob.id)).toEqual([])
    await expectUnchangedCall(row)
    mocks.getSession.mockResolvedValue(actualCalledChat())
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0].targetSessionId).not.toBeNull()
})

test.each(['remapped owner', 'deleting owner', 'changed call session'] as const)('rechecks %s after the asynchronous engine read', async changed => {
    const { row } = await unlinkedCall()
    mocks.getSession.mockImplementation(async () => {
        if (changed === 'remapped owner') await db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id=? WHERE id=?', args: ['replacement-engine', bob.id] })
        if (changed === 'deleting owner') await db.execute({ sql: 'INSERT INTO desktop_deletions(agent_id,engine_agent_id,name) VALUES(?,?,?)', args: [bob.id, bob.engineAgentId, bob.name] })
        if (changed === 'changed call session') await patchDesktopCoworkerCall(db, row.callId, { revision: row.revision }, { engineTargetSessionId: 'replacement-chat' }, NOW)
        return actualCalledChat()
    })
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0].targetSessionId).toBeNull()
    expect(await listDesktopSessions(db, bob.id)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
})

test('a live call remains owned by engine adoption, and Stop does not mutate its revision through a read', async () => {
    const { row } = await unlinkedCall({ status: 'dispatched', phase: 'launched' })
    mocks.getSession.mockResolvedValue(actualCalledChat())
    expect((await readDesktopCoworkerCalls(runtime, parentSession.id)).calls[0]).toMatchObject({ targetSessionId: null, revision: String(row.revision) })
    fetcher.mockImplementation(async (input, init) => {
        expect(new URL(String(input)).pathname).toBe(`/agents/${bob.engineAgentId}/runs/${row.engineChildRunId}/cancel`)
        expect(init?.method).toBe('POST')
        return Response.json({ cancelled: true })
    })
    const response = await stopDesktopCoworkerCall(runtime, parentSession.id, {
        operation: 'stop', requestId: crypto.randomUUID(), callId: row.callId, expectedRevision: String(row.revision),
    }, fetcher)
    expect(response.status).toBe(200)
    expect((await response.json()).call.status).toBe('cancelled')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(await listDesktopSessions(db, bob.id)).toEqual([])
})

test.each(['epoch', 'call session'] as const)('adopt-session refuses a changed %s after fetching the actual engine session', async changed => {
    const { row } = await unlinkedCall({ status: 'queued', phase: 'session-open', engineChildRunId: null })
    mocks.getSession.mockImplementation(async () => {
        if (changed === 'epoch') await adoptDesktopCoworkerCallEpoch(db, 'replacement-epoch', NOW, 'replacement-launch')
        else await patchDesktopCoworkerCall(db, row.callId, { revision: row.revision }, { engineTargetSessionId: 'replacement-chat' }, NOW)
        return actualCalledChat()
    })
    const response = await bridge(envelope('adopt-session', { publicAgentId: bob.id, engineSessionId: row.engineTargetSessionId, title: 'Untrusted title' }))
    expect(response.status).toBe(409)
    expect(await listDesktopSessions(db, bob.id)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
})
