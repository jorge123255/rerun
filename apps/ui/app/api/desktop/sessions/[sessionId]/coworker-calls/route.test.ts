import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { getDesktopCoworkerCall, initializeDesktopCoworkerCalls, insertDesktopCoworkerCall, type CoworkerCallRecord } from '@/lib/desktop/server/coworker-calls/db'
import { GET, POST } from './route'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
let root: string
let sessionId = ''
let otherSessionId = ''
const origin = 'http://127.0.0.1:3191'
const calls: string[] = []

const request = (session: string, payload?: unknown) => new Request(`${origin}/api/desktop/sessions/${session}/coworker-calls`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:3191', origin, cookie: `rerun-desktop-session=${'s'.repeat(48)}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
})
const send = (method: typeof GET | typeof POST, session: string, payload?: unknown) => method(request(session, payload), { params: Promise.resolve({ sessionId: session }) })
const stop = (callId: string, revision: string, requestId = crypto.randomUUID(), session = sessionId) => send(POST, session, { operation: 'stop', requestId, callId, expectedRevision: revision })

function record(overrides: Partial<CoworkerCallRecord> = {}): CoworkerCallRecord {
    return {
        callId: crypto.randomUUID(), revision: 1, sourceKey: crypto.randomUUID(), parentAgentId: crypto.randomUUID(), parentSessionId: sessionId,
        parentRunId: crypto.randomUUID(), toolCallId: 'tool-1', targetAgentId: crypto.randomUUID(), targetSessionId: null, targetName: 'Bob', wait: true,
        status: 'running', phase: 'launched', launchEpoch: 'epoch-1', launchClaimed: true, engineParentAgentId: 'engine-secret-parent',
        engineParentSessionId: 'engine-secret-session', engineParentRunId: 'engine-secret-run', engineTargetAgentId: 'engine-target',
        engineTargetSessionId: 'engine-child-session', engineChildRunId: 'engine-run-1', depth: 0, ancestors: [],
        progress: { steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] }, resultText: null, error: null, stopRequestId: null,
        createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', ...overrides,
    }
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-coworker-route-'))
    calls.length = 0
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'calls', buildId: 'calls-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: 's'.repeat(48) }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'engine-key' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    const agent = await createDesktopAgent(db, { name: 'Ann', engineAgentId: 'engine-ann' })
    sessionId = (await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-ann-session', title: 'Chat' })).id
    otherSessionId = (await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'engine-other-session', title: 'Other' })).id
    globalThis.fetch = (async (url: string | URL | Request) => {
        const path = String(url)
        calls.push(path)
        if (path.includes('/runs?')) return Response.json({ runs: [{ id: 'engine-run-live', agentId: 'engine-target', sessionId: 'engine-child-session', status: 'running' }] })
        if (path.endsWith('/cancel')) return Response.json({ ok: true })
        return new Response('missing', { status: 404 })
    }) as typeof fetch
})
afterEach(async () => {
    globalThis.fetch = originalFetch
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('lists public snapshots without engine ids and rejects a body that is not a stop', async () => {
    const db = await openDesktopDatabase(root)
    await initializeDesktopCoworkerCalls(db)
    const saved = record({ createdAt: '2026-11-05T00:00:02.000Z' })
    const older = record({ createdAt: '2026-11-05T00:00:01.000Z', sourceKey: 'older', toolCallId: 'tool-old' })
    await insertDesktopCoworkerCall(db, saved)
    await insertDesktopCoworkerCall(db, older)
    const response = await send(GET, sessionId)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).not.toContain('engine-secret')
    expect(body).not.toContain('engine-target')
    expect(body).not.toContain('engine-run')
    const parsed = JSON.parse(body) as { calls: { callId: string }[] }
    expect(parsed.calls.map(call => call.callId)).toEqual([saved.callId, older.callId])
    expect((await send(POST, sessionId, { operation: 'stop', requestId: crypto.randomUUID(), callId: saved.callId, expectedRevision: '1', extra: true })).status).toBe(400)
    expect((await send(POST, sessionId, { operation: 'list' })).status).toBe(400)
    expect((await send(POST, sessionId, null)).status).toBe(400)
    const anonymous = request(sessionId, { operation: 'stop', requestId: crypto.randomUUID(), callId: saved.callId, expectedRevision: '1' })
    anonymous.headers.delete('cookie')
    expect((await POST(anonymous, { params: Promise.resolve({ sessionId }) })).status).toBe(401)
})

test('stops only the named child run and keeps a failed stop retryable', async () => {
    const db = await openDesktopDatabase(root)
    await initializeDesktopCoworkerCalls(db)
    const launched = record()
    const unlaunched = record({ status: 'queued', phase: 'reserved', launchClaimed: false, engineChildRunId: null, engineTargetSessionId: null, sourceKey: 'reserved', toolCallId: 'tool-reserved' })
    const pending = record({ engineChildRunId: null, phase: 'session-open', sourceKey: 'opening', toolCallId: 'tool-opening', engineTargetSessionId: 'engine-child-session' })
    await insertDesktopCoworkerCall(db, launched)
    await insertDesktopCoworkerCall(db, unlaunched)
    await insertDesktopCoworkerCall(db, pending)
    const stopped = await stop(launched.callId, '1')
    expect(stopped.status).toBe(200)
    expect(calls).toEqual([`http://127.0.0.1:1/agents/engine-target/runs/${encodeURIComponent('engine-run-1')}/cancel`])
    expect((await stopped.json()).call).toMatchObject({ callId: launched.callId, status: 'cancelled', revision: '2' })
    calls.length = 0
    const requestId = String((await db.execute('SELECT request_id FROM desktop_coworker_call_stops')).rows[0]!.request_id)
    const replay = await stop(launched.callId, '1', requestId)
    expect(replay.status).toBe(200)
    expect(calls).toEqual([])
    const local = await stop(unlaunched.callId, '1')
    expect(local.status).toBe(200)
    expect((await local.json()).call.status).toBe('cancelled')
    expect(calls).toEqual([])
    const discovered = await stop(pending.callId, '1')
    expect(discovered.status).toBe(200)
    expect(calls.some(path => path.includes('/runs?session=engine-child-session'))).toBe(true)
    expect(calls.some(path => path.endsWith('/runs/engine-run-live/cancel'))).toBe(true)
    expect(calls.some(path => path.includes('engine-run-1'))).toBe(false)
    expect((await getDesktopCoworkerCall(db, pending.callId))?.engineChildRunId).toBe('engine-run-live')
})

test('a stale revision, another session, and an unavailable cancel do not stop a different run', async () => {
    const db = await openDesktopDatabase(root)
    await initializeDesktopCoworkerCalls(db)
    const first = record({ engineChildRunId: 'engine-run-a' })
    const second = record({ engineChildRunId: 'engine-run-b', sourceKey: 'second', toolCallId: 'tool-2', createdAt: '2026-11-05T00:00:03.000Z' })
    await insertDesktopCoworkerCall(db, first)
    await insertDesktopCoworkerCall(db, second)
    const stale = await stop(first.callId, '9')
    expect(stale.status).toBe(409)
    expect((await getDesktopCoworkerCall(db, first.callId))?.status).toBe('running')
    expect((await getDesktopCoworkerCall(db, second.callId))?.status).toBe('running')
    expect((await stop(first.callId, '1', crypto.randomUUID(), otherSessionId)).status).toBe(404)
    expect((await getDesktopCoworkerCall(db, first.callId))?.revision).toBe(1)
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    const offline = await stop(first.callId, '1')
    expect(offline.status).toBe(503)
    const offlineBody = await offline.json()
    expect(offlineBody.call.revision).toBe('1')
    expect(offlineBody.call.status).toBe('running')
    expect((await db.execute('SELECT request_id FROM desktop_coworker_call_stops WHERE http_status = 503')).rows).toEqual([])
    expect((await getDesktopCoworkerCall(db, first.callId))?.stopRequestId).toBeNull()
    globalThis.fetch = (async (url: string | URL | Request) => new Response(String(url).endsWith('/cancel') ? '{"ok":true}' : '{}', { status: String(url).endsWith('/cancel') ? 200 : 404, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const retried = await stop(first.callId, '1')
    expect(retried.status).toBe(200)
    expect((await retried.json()).call.status).toBe('cancelled')
    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch
    const missing = await stop(second.callId, '1')
    expect(missing.status).toBe(200)
    expect((await missing.json()).call.status).toBe('interrupted')
})
