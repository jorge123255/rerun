import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopSecretRequestDecision, DesktopSecretRequestInput, DesktopSecretRequestSource } from '@rerun/contracts'
import { createDesktopSecretCrypto, type DesktopSecretCrypto } from './crypto'
import { createDesktopSecretRequestRuntimePorts } from './runtime'
import { ensureDesktopSecretRequestSchema } from './schema'
import { createDesktopSecretRequestStore } from './store'
import type { DesktopSecretContinuationPorts } from './service'

let directory: string
let db: Client
const crypto = createDesktopSecretCrypto(() => Buffer.alloc(32, 9))
const source: DesktopSecretRequestSource = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const delivered: DesktopSecretRequestInput & { source: DesktopSecretRequestSource } = { source, fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example API key' }] }
const allow = { check: () => {} }

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-secret-qa-'))
    db = createClient({ url: `file:${join(directory, 'test.sqlite')}` })
    await db.executeMultiple("CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT); INSERT INTO desktop_agents VALUES('agent'); INSERT INTO desktop_sessions VALUES('chat','agent');")
    await ensureDesktopSecretRequestSchema(db)
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

async function fixture(encryption: DesktopSecretCrypto = crypto) {
    const store = createDesktopSecretRequestStore(db, encryption)
    const view = await store.publish(delivered)
    const input: DesktopSecretRequestDecision = { operation: 'save', requestId: view.requestId, attemptId: 'attempt', expectedRevision: view.revision, source, values: { EXAMPLE_API_KEY: 'private-value' } }
    const send = vi.fn<DesktopSecretContinuationPorts['send']>().mockResolvedValue({ status: 404, code: 'queued_turn_not_found', sessionId: null, runId: null })
    let current: typeof delivered | null = delivered
    const authority = vi.fn(() => allow)
    const runtime = createDesktopSecretRequestRuntimePorts({ store, authority, source: async () => current, send })
    return { store, input, send, authority, runtime, setCurrent: (next: typeof delivered | null) => { current = next } }
}

test('a superseded same-session source cannot seal credentials from its old card', async () => {
    const f = await fixture()
    f.setCurrent({ ...delivered, source: { ...source, toolCallId: 'replacement-tool' } })
    await expect(f.runtime.decide('chat', f.input, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]?.count).toBe(0)
    expect(f.send).not.toHaveBeenCalled()
})

test('source replacement during encryption rolls back credential and receipt writes', async () => {
    let replace = () => {}
    const f = await fixture({ ...crypto, seal: async (context, value) => {
        const result = await crypto.seal(context, value)
        if (context.domain === 'credential') replace()
        return result
    } })
    replace = () => f.setCurrent({ ...delivered, source: { ...source, runId: 'replacement-run' } })
    await expect(f.runtime.decide('chat', f.input, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]?.count).toBe(0)
    expect((await f.store.read(f.input.requestId))?.receipt).toBeUndefined()
    expect(f.send).not.toHaveBeenCalled()
})

test('sealed metadata recovery uses exact replay authority even after the pending source advances', async () => {
    const f = await fixture()
    const sealed = await f.store.decide(f.input, allow)
    f.setCurrent(null)
    f.send.mockResolvedValue({ status: 204, sessionId: source.sessionId, runId: sealed.continuationRequestId })
    const input = { operation: 'recover' as const, requestId: f.input.requestId, attemptId: f.input.attemptId, expectedRevision: f.input.expectedRevision, source }
    await f.runtime.recover('chat', input, new AbortController().signal)
    expect(f.authority).toHaveBeenCalledWith('chat', source, 'replay')
    expect(f.send.mock.calls.map(call => call[2])).toEqual(['replay'])
    expect((await f.store.read(f.input.requestId))?.status).toBe('accepted')
    expect((await db.execute('SELECT version FROM desktop_secret_credentials')).rows[0]?.version).toBe(1)
})

test('staged metadata recovery still requires the current source and a live request signal', async () => {
    const f = await fixture()
    await f.store.stage(f.input, allow)
    const input = { operation: 'recover' as const, requestId: f.input.requestId, attemptId: f.input.attemptId, expectedRevision: f.input.expectedRevision, source }
    f.setCurrent(null)
    await expect(f.runtime.recover('chat', input, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    f.setCurrent(delivered)
    const stop = new AbortController()
    stop.abort()
    await expect(f.runtime.recover('chat', input, stop.signal)).rejects.toThrow()
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]?.count).toBe(0)
})

test('passive reads preview a stable form without inserting a request, then the explicit decision publishes it', async () => {
    const store = createDesktopSecretRequestStore(db, crypto)
    const send = vi.fn<DesktopSecretContinuationPorts['send']>(async (receipt, _source, mode) => mode === 'replay'
        ? { status: 404, code: 'queued_turn_not_found', sessionId: null, runId: null }
        : { status: 204, sessionId: 'chat', runId: receipt.continuationRequestId })
    const runtime = createDesktopSecretRequestRuntimePorts({ store, authority: () => allow, source: async () => ({ ...delivered, requestedAt: '2026-11-05T00:00:00Z' }), send })
    const first = (await runtime.read('chat', new AbortController().signal))!
    const second = (await runtime.read('chat', new AbortController().signal))!
    expect(second).toEqual(first)
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_requests')).rows[0]?.count).toBe(0)
    await runtime.decide('chat', { operation: 'skip', source, requestId: first.requestId, expectedRevision: first.revision, attemptId: 'explicit-skip' }, new AbortController().signal)
    expect((await store.read(first.requestId))?.status).toBe('accepted')
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_secret_credentials')).rows[0]?.count).toBe(0)
})
