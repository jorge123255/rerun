import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopSecretCrypto } from './crypto'
import { ensureDesktopSecretRequestSchema } from './schema'
import { createDesktopSecretRequestContinuation, desktopSecretRequestAttention, type DesktopSecretContinuationPorts } from './service'
import { createDesktopSecretRequestStore, type DesktopSecretRequestStore } from './store'
import type { DesktopSecretRequestDecision, DesktopSecretRequestSource } from '@rerun/contracts'

let directory: string
let db: Client
let store: DesktopSecretRequestStore
const source: DesktopSecretRequestSource = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const fields = [{ key: 'EXAMPLE_API_KEY', label: 'Example API key' }]
const allow = { check: () => {} }

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-secret-qa-'))
    db = createClient({ url: `file:${join(directory, 'test.sqlite')}` })
    await db.executeMultiple("CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT); INSERT INTO desktop_agents VALUES('agent'); INSERT INTO desktop_sessions VALUES('chat','agent');")
    await ensureDesktopSecretRequestSchema(db)
    store = createDesktopSecretRequestStore(db, createDesktopSecretCrypto(() => Buffer.alloc(32, 8)))
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

async function input(): Promise<DesktopSecretRequestDecision> {
    const view = await store.publish({ source, fields })
    return { operation: 'save', requestId: view.requestId, attemptId: 'attempt', expectedRevision: view.revision, source, values: { EXAMPLE_API_KEY: 'dummy-secret' } }
}

test('decision persists before replay/send and a lost response recovers the same run without a duplicate', async () => {
    const body = new ReadableStream<Uint8Array>()
    const send = vi.fn<DesktopSecretContinuationPorts['send']>(async receipt => {
        const call = send.mock.calls.length
        if (call === 1) return { status: 404, code: 'queued_turn_not_found', sessionId: null, runId: null }
        return { status: 200, sessionId: 'chat', runId: receipt.continuationRequestId, body, contentType: 'text/event-stream' }
    })
    const continuation = createDesktopSecretRequestContinuation(store, { send })
    const request = await input()
    const first = await continuation.decide(request, allow)
    expect(first.headers.get('x-run-id')).toBe(send.mock.calls[1]![0].continuationRequestId)
    expect(send).toHaveBeenCalledTimes(2)
    expect((await store.read(request.requestId))?.status).toBe('accepted')
    const replay = await continuation.decide(request, allow)
    expect(replay.headers.get('x-secret-request-id')).toBe(request.requestId)
    expect(send).toHaveBeenCalledTimes(2)
})

test('unknown continuation acknowledgement remains sealed and retryable, never accepted early', async () => {
    const send = vi.fn().mockResolvedValue({ status: 502, sessionId: null, runId: null })
    const continuation = createDesktopSecretRequestContinuation(store, { send })
    const request = await input()
    await expect(continuation.decide(request, allow)).rejects.toMatchObject({ status: 502 })
    expect((await store.read(request.requestId))?.status).toBe('sealed')
    expect(desktopSecretRequestAttention(await store.read(request.requestId)).pending).toBe(true)
})

test('pending-inbox completion races project names only and exact mark-read guards', async () => {
    const request = await input()
    const pending = desktopSecretRequestAttention(await store.read(request.requestId))
    expect(pending).toMatchObject({ pending: true, requestId: request.requestId, toolCallId: 'tool' })
    expect(JSON.stringify(pending)).not.toContain('dummy-secret')
    const sealed = await store.decide(request, allow)
    await store.markAccepted(sealed.requestId, sealed.continuationRequestId, allow)
    const completed = desktopSecretRequestAttention(await store.read(request.requestId))
    expect(completed.pending).toBe(false)
    expect(completed.canMarkRead).toBe(true)
})

test('sealed recovery never dispatches a new continuation after a replay miss', async () => {
    const request = await input()
    await store.decide(request, allow)
    const send = vi.fn<DesktopSecretContinuationPorts['send']>().mockResolvedValue({ status: 404, code: 'queued_turn_not_found', sessionId: null, runId: null })
    const continuation = createDesktopSecretRequestContinuation(store, { send })
    await expect(continuation.recover({ operation: 'recover', requestId: request.requestId, attemptId: request.attemptId, expectedRevision: request.expectedRevision, source }, allow)).rejects.toMatchObject({ status: 502 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[2]).toBe('replay')
    expect((await store.read(request.requestId))?.receipt?.accepted).toBe(false)
})

test('metadata-only sealed recovery acknowledges the existing continuation without changing credentials', async () => {
    const request = await input()
    const sealed = await store.decide(request, allow)
    const send = vi.fn<DesktopSecretContinuationPorts['send']>().mockResolvedValue({ status: 204, sessionId: source.sessionId, runId: sealed.continuationRequestId })
    const continuation = createDesktopSecretRequestContinuation(store, { send })
    await continuation.recover({ operation: 'recover', requestId: request.requestId, attemptId: request.attemptId, expectedRevision: request.expectedRevision, source }, allow)
    expect(send.mock.calls.map(call => call[2])).toEqual(['replay'])
    expect((await store.read(request.requestId))?.status).toBe('accepted')
    expect((await db.execute('SELECT version FROM desktop_secret_credentials')).rows[0]?.version).toBe(1)
})
