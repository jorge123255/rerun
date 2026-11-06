import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ensureDesktopMcpSignInSchema } from './schema'
import { createDesktopMcpSignInContinuation, desktopMcpSignInAttention } from './service'
import { createDesktopMcpSignInStore } from './store'
import type { DesktopMcpSignInDecision, DesktopMcpSignInSource } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'

let db: Client
const source: DesktopMcpSignInSource = {
    agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint',
    server: { name: 'linear', revision: 'revision-1', url: 'https://linear.example/mcp', displayName: 'Linear', host: 'linear.example', icon: null },
}
beforeEach(async () => {
    db = createClient({ url: temporaryDatabaseUrl() })
    await db.executeMultiple(`CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT); INSERT INTO desktop_agents VALUES ('agent'); INSERT INTO desktop_sessions VALUES ('chat','agent');`)
    await ensureDesktopMcpSignInSchema(db)
})
afterEach(() => db.close())

test('lost acknowledgement replays the same continuation without replaying OAuth', async () => {
    const store = createDesktopMcpSignInStore(db)
    const view = await store.publish({ source, name: 'linear' })
    const input: DesktopMcpSignInDecision = { operation: 'connect', requestId: view.requestId, attemptId: 'attempt', expectedRevision: view.revision, source }
    const send = vi.fn(async (receipt: { continuationRequestId: string }, _source: unknown, mode: 'send' | 'replay') => mode === 'replay'
        ? { status: 404, code: 'queued_turn_not_found', sessionId: null, runId: null }
        : { status: 200, sessionId: 'chat', runId: receipt.continuationRequestId, body: null, contentType: 'text/event-stream' })
    const continuation = createDesktopMcpSignInContinuation(store, { send })
    input.expectedRevision = (await store.begin(input, { check: () => {} })).revision
    const first = await continuation.complete(input, { check: () => {} })
    expect(first.headers.get('x-run-id')).toBe(send.mock.calls[1]![0].continuationRequestId)
    const replay = await continuation.recover(input, { check: () => {} })
    expect(replay.headers.get('x-mcp-sign-in-request-id')).toBe(view.requestId)
    expect(send).toHaveBeenCalledTimes(2)
    expect(desktopMcpSignInAttention(await store.read(view.requestId))).toMatchObject({ pending: false, canMarkRead: true, serverName: 'linear', toolCallId: 'tool' })
})

const temporaryDirectories: string[] = []
function temporaryDatabaseUrl() { const path = mkdtempSync(join(tmpdir(), 'rerun-ledger-')); temporaryDirectories.push(path); return `file:${join(path, 'app.db')}` }
afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
