import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent, createDesktopSession, type DesktopAgent, type DesktopSession } from '../store'
import { ensureDesktopSecretRequestSchema } from './schema'
import { desktopSecretRequestPorts, readDesktopSecretRequestView } from './binding'
import { createDesktopSecretRequestStore } from './store'
import { createDesktopSecretCrypto } from './crypto'

const calls = vi.hoisted(() => ({ request: vi.fn(), chat: vi.fn(), runtime: vi.fn(), model: vi.fn() }))
vi.mock('@/lib/engine/client', async original => ({ ...await original<typeof import('@/lib/engine/client')>(), request: calls.request, chat: calls.chat }))
vi.mock('../runtime', async original => ({ ...await original<typeof import('../runtime')>(), readDesktopRuntime: calls.runtime }))
vi.mock('../chat-model', () => ({ resolveDesktopChatModel: calls.model }))
let directory: string, runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession
let current = true, enabled = true, granted = true, foreign = false
const input = { fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example key' }], reason: 'Read the example account' }
const guard = { runId: 'source-run', sourceMessageId: 'source-message', toolCallId: 'source-call', fingerprint: JSON.stringify(input) }
const signal = () => new AbortController().signal

beforeEach(async () => {
    vi.clearAllMocks(); current = true; enabled = true; granted = true; foreign = false
    directory = await mkdtemp(join(tmpdir(), 'rerun-secret-binding-'))
    runtime = { protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'fixture', workspaceId: 1, dataRoot: directory, app: { origin: 'http://127.0.0.1:3100', sessionToken: 'x'.repeat(48) }, engine: { origin: 'http://127.0.0.1:3200', apiKey: 'fixture' } }
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '07'.repeat(32))
    const db = await openDesktopDatabase(directory)
    await ensureDesktopSecretRequestSchema(db)
    agent = await createDesktopAgent(db, { name: 'Credential fixture', engineAgentId: 'engine-owner' })
    session = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-chat', title: 'Credential test' })
    calls.runtime.mockImplementation(async () => runtime)
    calls.model.mockResolvedValue({ connectionId: 'connection', model: 'selected-model', source: 'conversation' })
    calls.request.mockImplementation(async (_connection, path: string, init: RequestInit) => {
        if (path.endsWith('/secret-request-source')) {
            const body = JSON.parse(String(init.body))
            return { agentId: foreign ? 'another-engine-owner' : agent.engineAgentId, sessionId: session.engineSessionId,
                request: current || body.source ? { input, guard, status: 'done', requestedAt: '2026-11-05T00:00:00Z' } : null }
        }
        return { id: agent.engineAgentId, config: { enabled, ephemeral: false, tools: { desktopToolGrants: { requestSecret: granted } } } }
    })
    calls.chat.mockImplementation(async (_connection, _agent, body) => body.desktopQueuedTurn.replayOnly
        ? Response.json({ code: 'queued_turn_not_found' }, { status: 404 })
        : new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': session.engineSessionId, 'x-run-id': body.desktopQueuedTurn.runId } }))
})
afterEach(async () => { await closeDesktopDatabase(directory); await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs() })

async function decision() {
    const view = (await readDesktopSecretRequestView(runtime, session.id)).request!
    return { operation: 'save' as const, requestId: view.requestId, attemptId: crypto.randomUUID(), expectedRevision: view.revision, source: view.source, values: { EXAMPLE_API_KEY: 'fixture-private-secret' } }
}

test('uses the shared database/master-key authority and sends only metadata to the exact chat/model', async () => {
    const value = await decision()
    const db = await openDesktopDatabase(directory)
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_requests')).rows[0]?.count).toBe(0)
    const response = await desktopSecretRequestPorts(runtime, session.id).decide(session.id, value, signal())
    expect(response.headers.get('x-session-id')).toBe(session.id)
    expect(calls.chat).toHaveBeenCalledTimes(2)
    const sent = calls.chat.mock.calls[1][2]
    expect(sent).toMatchObject({ sessionId: 'engine-chat', connectionId: 'connection', model: 'selected-model', desktopQueuedTurn: { secret: guard } })
    expect(JSON.stringify(calls.chat.mock.calls)).not.toContain('fixture-private-secret')
    expect(sent.message).toContain('EXAMPLE_API_KEY: provided')
    const row = (await db.execute('SELECT * FROM desktop_secret_credentials')).rows[0]
    expect(String(row.sealed_value)).not.toContain('fixture-private-secret')
    const store = createDesktopSecretRequestStore(db, createDesktopSecretCrypto(() => Buffer.from('07'.repeat(32), 'hex')))
    expect((await store.read(value.requestId))?.status).toBe('accepted')
    await store.useCredential(agent.id, 'EXAMPLE_API_KEY', { check: () => {} }, bytes => expect(new TextDecoder().decode(bytes)).toBe('fixture-private-secret'))
})

test.each(['permission', 'disabled', 'foreign'] as const)('refuses a %s source without saving a credential or sending a message', async failure => {
    const value = await decision()
    if (failure === 'permission') granted = false
    if (failure === 'disabled') enabled = false
    if (failure === 'foreign') foreign = true
    await expect(desktopSecretRequestPorts(runtime, session.id).decide(session.id, value, signal())).rejects.toMatchObject({ status: 409 })
    expect((await (await openDesktopDatabase(directory)).execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]?.count).toBe(0)
    expect(calls.chat).not.toHaveBeenCalled()
})

test('restart recovery replays only the saved receipt even after the source advances and the grant is revoked', async () => {
    const value = await decision()
    calls.chat.mockImplementation(async (_connection, _agent, body) => {
        if (body.desktopQueuedTurn.replayOnly) return Response.json({ code: 'queued_turn_not_found' }, { status: 404 })
        throw new Error('Lost send acknowledgement')
    })
    await expect(desktopSecretRequestPorts(runtime, session.id).decide(session.id, value, signal())).rejects.toMatchObject({ status: 502 })
    await closeDesktopDatabase(directory)
    runtime = { ...runtime, launchNonce: crypto.randomUUID() }; current = false; granted = false; enabled = false
    calls.chat.mockClear().mockImplementation(async (_connection, _agent, body) => new Response(null, { status: 204, headers: { 'x-session-id': session.engineSessionId, 'x-run-id': body.desktopQueuedTurn.runId } }))
    const recovered = (await readDesktopSecretRequestView(runtime, session.id)).request!
    expect(recovered.receipt?.accepted).toBe(false)
    await desktopSecretRequestPorts(runtime, session.id).recover(session.id, { operation: 'recover', requestId: value.requestId, attemptId: value.attemptId, expectedRevision: value.expectedRevision, source: value.source }, signal())
    expect(calls.chat).toHaveBeenCalledTimes(1)
    expect(calls.chat.mock.calls[0][2].desktopQueuedTurn.replayOnly).toBe(true)
    expect((await (await openDesktopDatabase(directory)).execute('SELECT version FROM desktop_secret_credentials')).rows[0]?.version).toBe(1)
    expect((await readDesktopSecretRequestView(runtime, session.id)).request).toBeNull()
})
