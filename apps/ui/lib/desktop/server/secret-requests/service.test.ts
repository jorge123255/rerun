import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopSecretCrypto } from './crypto'
import { ensureDesktopSecretRequestSchema } from './schema'
import { createDesktopSecretRequestContinuation, desktopSecretRequestAttention } from './service'
import { createDesktopSecretRequestStore, type DesktopSecretRequestStore } from './store'
import type { DesktopSecretRequestDecision, DesktopSecretRequestSource } from '../../../../../../packages/contracts/src/desktop-secret-requests'

let db: Client
let store: DesktopSecretRequestStore
const source: DesktopSecretRequestSource = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const fields = [{ key: 'EXAMPLE_API_KEY', label: 'Example API key' }]
const allow = { check: () => {} }

beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    await db.executeMultiple('CREATE TABLE desktop_agents (id TEXT PRIMARY KEY); CREATE TABLE desktop_sessions (id TEXT PRIMARY KEY, agent_id TEXT);')
    await ensureDesktopSecretRequestSchema(db)
    store = createDesktopSecretRequestStore(db, createDesktopSecretCrypto(() => Buffer.alloc(32, 8)))
})
afterEach(() => db.close())

async function input(): Promise<DesktopSecretRequestDecision> {
    const view = await store.publish({ source, fields })
    return { operation: 'save', requestId: view.requestId, attemptId: 'attempt', expectedRevision: view.revision, source, values: { EXAMPLE_API_KEY: 'dummy-secret' } }
}

test('decision persists before replay/send and a lost response recovers the same run without a duplicate', async () => {
    const body = new ReadableStream<Uint8Array>()
    const send = vi.fn(async (receipt: { continuationRequestId: string }) => {
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
    await store.markAccepted(sealed.requestId, sealed.continuationRequestId)
    const completed = desktopSecretRequestAttention(await store.read(request.requestId))
    expect(completed.pending).toBe(false)
    expect(completed.canMarkRead).toBe(true)
})
