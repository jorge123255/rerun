import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, test, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { ensureDesktopMcpSignInSchema } from './schema'
import { createDesktopMcpSignInStore } from './store'
import { createDesktopMcpSignInContinuation } from './service'
import { createDesktopMcpSignInRuntimePorts } from './runtime'
import type { DesktopMcpSignInDecision } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
const clients: ReturnType<typeof createClient>[] = []
afterEach(() => clients.splice(0).forEach(client => client.close()))
const source = { agentId: 'a', sessionId: 's', runId: 'r', sourceMessageId: 'm', toolCallId: 't', fingerprint: 'f', server: { name: 'linear', revision: 'rev', url: 'https://example.org/mcp', displayName: 'Linear' } }
const authority = { check() {} }
async function fixture() {
    const db = createClient({ url: temporaryDatabaseUrl() }); clients.push(db)
    await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('a'); INSERT INTO desktop_sessions VALUES('s');")
    await ensureDesktopMcpSignInSchema(db)
    const store = createDesktopMcpSignInStore(db), view = await store.publish({ name: 'linear', source })
    const input: DesktopMcpSignInDecision = { operation: 'connect', requestId: view.requestId, expectedRevision: view.revision, attemptId: 'A', source }
    return { db, store, input }
}
test('cancelled attempt cannot cancel, fail or complete a later attempt', async () => {
    const { store, input } = await fixture()
    const first = await store.begin(input, authority), a = { ...input, expectedRevision: first.revision }
    const cancelled = await store.cancel({ ...a, operation: 'cancel' }, authority)
    const b = { ...input, attemptId: 'B', expectedRevision: cancelled.revision }
    const second = await store.begin(b, authority)
    await expect(store.fail(a, 'late error')).rejects.toThrow()
    await expect(store.cancel({ ...a, operation: 'cancel' })).rejects.toThrow()
    await expect(store.seal(a, 'connected', authority)).rejects.toThrow()
    expect((await store.read(input.requestId))?.activeAttemptId).toBe('B')
    expect((await store.read(input.requestId))?.revision).toBe(second.revision)
})
test('duplicate connect reserves once and preserves cancelled tombstones', async () => {
    const { store, input } = await fixture()
    const a = await store.beginAttempt(input, authority), duplicate = await store.beginAttempt(input, authority)
    expect(a.created).toBe(true); expect(duplicate.created).toBe(false)
    const cancelled = await store.cancel({ ...input, operation: 'cancel', expectedRevision: a.request.revision }, authority)
    await expect(store.begin({ ...input, expectedRevision: cancelled.revision }, authority)).rejects.toThrow()
})
test('sealed recovery after runtime recreation is replay-only even when the queue has no record', async () => {
    const { store, db, input } = await fixture(), begun = await store.begin(input, authority)
    await store.seal({ ...input, expectedRevision: begun.revision }, 'connected', authority)
    const send = vi.fn(async (_receipt: unknown, _source: unknown, _mode: 'send' | 'replay') => ({ status: 404, code: 'queued_turn_not_found', sessionId: null, runId: null }))
    const service = createDesktopMcpSignInContinuation(createDesktopMcpSignInStore(db), { send })
    await expect(service.recover(input, authority)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]?.[2]).toBe('replay')
})
test('forged cancellation has no OAuth effect and failures never save provider text', async () => {
    const { store, input } = await fixture(), begun = await store.begin(input, authority)
    const cancel = vi.fn(async () => {})
    const runtime = createDesktopMcpSignInRuntimePorts({ store, source: async () => null, authority: async () => authority, oauth: { start: async () => ({ state: 'idle' }), status: async () => ({ state: 'idle' }), cancel, ready: async () => {} }, send: async () => { throw Error() } })
    await expect(runtime.cancel({ ...input, operation: 'cancel', expectedRevision: begun.revision, source: { ...source, server: { ...source.server, name: 'other' } } }, new AbortController().signal)).rejects.toThrow()
    expect(cancel).not.toHaveBeenCalled()
    const failed = await store.fail({ ...input, expectedRevision: begun.revision }, 'secret=must-not-appear', authority)
    expect(JSON.stringify(failed)).not.toContain('must-not-appear')
})

const temporaryDirectories: string[] = []
function temporaryDatabaseUrl() { const path = mkdtempSync(join(tmpdir(), 'rerun-ledger-')); temporaryDirectories.push(path); return `file:${join(path, 'app.db')}` }
afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))


test('pending inbox metadata reads preserve the exact request without touching OAuth', async () => {
    const { store } = await fixture(), status = vi.fn(async () => ({ state: 'idle' as const })), start = vi.fn(async () => ({ state: 'idle' as const })), ready = vi.fn(async () => {})
    const authorize = vi.fn(async () => authority)
    const runtime = createDesktopMcpSignInRuntimePorts({ store, source: async () => ({ name: 'linear', source }), authority: authorize, oauth: { start, status, ready, cancel: async () => {} }, send: async () => { throw Error('not a read') } })
    const view = await runtime.read('s', new AbortController().signal, { metadataOnly: true })
    expect(view.request?.source).toEqual(source)
    expect(view.oauth).toBeUndefined(); expect(status).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled()
    expect(authorize).toHaveBeenCalledWith(source, expect.any(AbortSignal), 'read')
})

test('a refused exact OAuth cancellation leaves decline retryable without sealing an undispatched receipt', async () => {
    const { store, input } = await fixture(), begun = await store.begin(input, authority)
    const cancel = vi.fn(async () => { throw Error('close unavailable') }), send = vi.fn(async () => { throw Error('not sent') })
    const authorize = vi.fn(async () => authority)
    const runtime = createDesktopMcpSignInRuntimePorts({ store, source: async () => ({ name: 'linear', source }), authority: authorize, oauth: { start: async () => ({ state: 'idle' }), status: async () => ({ state: 'idle' }), ready: async () => {}, cancel }, send })
    await expect(runtime.decline({ ...input, operation: 'decline', attemptId: 'decline-A', expectedRevision: begun.revision }, new AbortController().signal)).rejects.toThrow('close unavailable')
    expect((await store.read(input.requestId))?.receipt).toBeUndefined()
    expect(send).not.toHaveBeenCalled(); expect(authorize).toHaveBeenCalledWith(source, expect.any(AbortSignal), 'dismiss')
})
