import { afterEach, expect, test, vi } from 'vitest'
import { readDesktopSecretRequest, submitDesktopSecretRequestDecision } from './secret-requests-client'
import type { DesktopSecretRequestDecision, DesktopSecretRequestSource } from '@rerun/contracts'

const source: DesktopSecretRequestSource = { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint' }
const decision: DesktopSecretRequestDecision = { operation: 'save', requestId: 'request', attemptId: 'attempt', expectedRevision: 'revision', source, values: { EXAMPLE_API_KEY: '  exact bytes\r\n' } }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('GET uses the canonical no-store session route and returns the names-only view', async () => {
    const request = { requestId: 'request', revision: 'revision', source, fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example', existing: true }], status: 'pending', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }
    const fetcher = vi.fn(async () => Response.json({ request }))
    vi.stubGlobal('fetch', fetcher)
    await expect(readDesktopSecretRequest('chat')).resolves.toEqual(request)
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/sessions/chat/secret-requests', { cache: 'no-store', signal: undefined })
})

test('POST preserves exact bytes and accepts only the matching request/run acknowledgement', async () => {
    const response = new Response('data: [DONE]\n\n', { headers: { 'x-secret-request-id': 'request', 'x-run-id': 'continuation', 'x-session-id': 'chat' } })
    const fetcher = vi.fn<typeof fetch>(async () => response)
    vi.stubGlobal('fetch', fetcher)
    await expect(submitDesktopSecretRequestDecision('chat', decision)).resolves.toBe(response)
    const init = fetcher.mock.calls[0]![1]!
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(decision)
    expect(JSON.parse(String(init.body)).values.EXAMPLE_API_KEY).toBe('  exact bytes\r\n')
})

test('unknown or foreign acknowledgement is an error and cannot clear the form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Save acknowledgement unknown.' }, { status: 502 })))
    await expect(submitDesktopSecretRequestDecision('chat', decision)).rejects.toThrow('Save acknowledgement unknown.')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', { headers: { 'x-secret-request-id': 'other', 'x-run-id': 'continuation', 'x-session-id': 'chat' } })))
    await expect(submitDesktopSecretRequestDecision('chat', decision)).rejects.toThrow('acknowledgement')
})

test('recovery sends only durable identities and never the original submitted values', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n', { headers: { 'x-secret-request-id': 'request', 'x-run-id': 'continuation', 'x-session-id': 'chat' } }))
    vi.stubGlobal('fetch', fetcher)
    const input = { operation: 'recover' as const, requestId: decision.requestId, attemptId: decision.attemptId, expectedRevision: decision.expectedRevision, source }
    await submitDesktopSecretRequestDecision('chat', input)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(input)
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('exact bytes')
})
