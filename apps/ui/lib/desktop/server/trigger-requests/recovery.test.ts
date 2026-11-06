import type { Client } from '@libsql/client'
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ chat: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ chat: mocks.chat }))
vi.mock('../settings', () => ({ engineOf: () => ({ origin: 'http://127.0.0.1:1', apiKey: 'test-only' }) }))
import { probeCanonicalTriggerAdmission } from './recovery'
import { decisionDigest } from './identity'
import type { TriggerRequestRootBindings } from './canonical'
import type { DesktopRuntime } from '../runtime'
import { testTriggerLink as link } from '../../trigger-requests/fixtures.test-support'
const runtime = {} as DesktopRuntime
const root = {} as TriggerRequestRootBindings
const record = { link, continuationId: '00000000-0000-5000-a000-000000000001', decisionDigest: 'digest', phase: 'uncertain' as const, version: 1 }
function database() {
    return { execute: vi.fn(async () => ({ rows: [{ request_id: record.continuationId, answer_text: 'Question: What is 6 × 7?\nAnswer: 42', source_guard: JSON.stringify({ sourceMessageId: link.sourceMessageId, toolCallId: link.toolCallId, fingerprint: 'canonical-source' }) }] })) } as unknown as Client
}
describe('lost admission receipt probes', () => {
    it('only uses replayOnly and the original exact conversation and immutable guard', async () => {
        mocks.chat.mockResolvedValueOnce(new Response('data: [DONE]\n\n', { headers: { 'x-session-id': link.engineSessionId, 'x-run-id': record.continuationId } }))
        expect(await probeCanonicalTriggerAdmission(runtime, database(), root, record)).toEqual({ status: 'accepted', continuationId: record.continuationId })
        expect(mocks.chat.mock.calls.at(-1)?.[2]).toMatchObject({ sessionId: link.engineSessionId, source: 'dashboard', desktopQueuedTurn: { replayOnly: true, runId: record.continuationId, question: { toolCallId: link.toolCallId } } })
    })
    it('a missing queued turn is reserved, never resent or treated as Done', async () => {
        const before = mocks.chat.mock.calls.length
        mocks.chat.mockResolvedValueOnce(Response.json({ code: 'queued_turn_not_found' }, { status: 404 }))
        expect(await probeCanonicalTriggerAdmission(runtime, database(), root, record)).toEqual({ status: 'reserved' })
        expect(mocks.chat.mock.calls.length - before).toBe(1)
    })
    it('foreign replies and provider/network failure remain unknown', async () => {
        mocks.chat.mockResolvedValueOnce(new Response(null, { headers: { 'x-session-id': 'private-chat', 'x-run-id': record.continuationId } }))
        expect(await probeCanonicalTriggerAdmission(runtime, database(), root, record)).toEqual({ status: 'unknown' })
        mocks.chat.mockRejectedValueOnce(new Error('connection changed'))
        expect(await probeCanonicalTriggerAdmission(runtime, database(), root, record)).toEqual({ status: 'unknown' })
    })
    it('does not invent a credential replay authority or send values to chat', async () => {
        const before = mocks.chat.mock.calls.length
        expect(await probeCanonicalTriggerAdmission(runtime, database(), root, { ...record, link: { ...link, kind: 'secret' } })).toEqual({ status: 'unknown' })
        expect(mocks.chat.mock.calls.length).toBe(before)
    })
    it('never fingerprints secret values in the linkage journal', () => {
        const input = { requestId: 'secret-request', attemptId: 'attempt', expectedRevision: 'revision', operation: 'save' as const,
            source: { agentId: link.agentId, sessionId: link.sessionId, runId: link.sourceRunId, sourceMessageId: link.sourceMessageId, toolCallId: link.toolCallId, fingerprint: 'sealed-source' } }
        expect(decisionDigest({ kind: 'secret', input: { ...input, values: { API_KEY: 'first-private-value' } } })).toBe(decisionDigest({ kind: 'secret', input: { ...input, values: { API_KEY: 'second-private-value' } } }))
    })
})
