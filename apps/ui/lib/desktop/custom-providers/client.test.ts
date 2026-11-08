import { describe, expect, it, vi } from 'vitest'
import type { CustomProviderChange } from '@rerun/contracts'
import { DESKTOP_CUSTOM_PROVIDER_ROUTE } from './messages'
import { createDesktopCustomProviderClient } from './client'

type ClientFetch = NonNullable<NonNullable<Parameters<typeof createDesktopCustomProviderClient>[0]>['fetch']>

const identity = { workspaceId: 1, connectionId: 'cnx-ollama', revision: 1 }
const signal = new AbortController().signal

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('desktop custom provider client', () => {
    it('posts the published request to the desktop route and never puts the key in the url', async () => {
        const fetch = vi.fn<ClientFetch>(async () => json({ identity, status: 'fresh', models: [{ id: 'llama3.2:3b', contextWindow: 8192, vision: false, source: 'discovered' }], problem: null, manualModel: null, manualUsable: false, observedAt: 1 }))
        const client = createDesktopCustomProviderClient({ fetch, route: DESKTOP_CUSTOM_PROVIDER_ROUTE })
        const result = await client.probe(identity, undefined, signal)
        expect(result.ok).toBe(true)
        expect(fetch).toHaveBeenCalledWith(DESKTOP_CUSTOM_PROVIDER_ROUTE, expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }))
        const init = fetch.mock.calls[0]![1]
        expect(String(init.body)).not.toContain('sk-')
        expect(String(fetch.mock.calls[0]?.[0])).not.toContain('sk-')
    })

    it('refuses a body that is not the published probe instead of accepting an invented catalog', async () => {
        const fetch = vi.fn<ClientFetch>(async () => json({ models: ['invented-model'] }))
        const client = createDesktopCustomProviderClient({ fetch })
        const result = await client.probe(identity, undefined, signal)
        expect(result).toEqual({ ok: false, reason: 'invalid', message: 'Custom provider request unavailable, cancelled or changed. Retry the same request to recover its receipt.' })
        if (!result.ok) expect(JSON.stringify(result)).not.toContain('invented-model')
    })

    it('keeps a 409 retryable and strips a key that leaked into the error', async () => {
        const fetch = vi.fn<ClientFetch>(async (_url, init) => json({ error: `bad ${JSON.parse(String(init.body)).change.apiKey}` }, 409))
        const client = createDesktopCustomProviderClient({ fetch })
        const change = { action: 'create', requestId: crypto.randomUUID(), workspaceId: 1, connectionId: 'cnx-new', config: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', preset: 'ollama', models: [{ id: 'llama3.3:70b', contextWindow: null, vision: false, source: 'manual' }], contextWindow: null, vision: false, policy: { reviewedOrigin: 'http://localhost:11434', allowHttp: true, allowPrivate: true } }, apiKey: 'sk-test-secret' } as CustomProviderChange
        const result = await client.change(change, signal)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.reason).toBe('unavailable')
            expect(result.message).not.toContain('sk-test-secret')
        }
    })

    it('does not send an invalid create and reports cancellation', async () => {
        const fetch = vi.fn<ClientFetch>()
        const client = createDesktopCustomProviderClient({ fetch })
        const invalid = await client.change({ action: 'create' } as CustomProviderChange, signal)
        expect(invalid.ok).toBe(false)
        expect(fetch).not.toHaveBeenCalled()
        const controller = new AbortController()
        controller.abort()
        fetch.mockImplementation(() => { throw new DOMException('aborted', 'AbortError') })
        const cancelled = await client.probe(identity, undefined, controller.signal)
        expect(cancelled).toMatchObject({ ok: false, reason: 'cancelled' })
    })

    it('posts probe_draft and drops a body that is not that probe', async () => {
        const fetch = vi.fn<ClientFetch>(async () => json({ models: ['invented-model'] }))
        const client = createDesktopCustomProviderClient({ fetch })
        const result = await client.probeDraft({ action: 'probe_draft', requestId: crypto.randomUUID(), workspaceId: 1, baseUrl: 'http://localhost:11434/v1', policy: { reviewedOrigin: 'http://localhost:11434', allowHttp: true, allowPrivate: true } }, signal)
        expect(result.ok).toBe(false)
        expect(JSON.stringify(result)).not.toContain('invented-model')
        expect(fetch).toHaveBeenCalledOnce()
        const init = fetch.mock.calls[0]![1]
        expect(String(init.body)).toContain('probe_draft')
        expect(String(init.body)).not.toContain('sk-')
    })

    it('strips a key echoed by a draft probe error', async () => {
        const fetch = vi.fn<ClientFetch>(async (_url, init) => json({ error: `bad ${JSON.parse(String(init.body)).apiKey}` }, 409))
        const client = createDesktopCustomProviderClient({ fetch })
        const result = await client.probeDraft({ action: 'probe_draft', requestId: crypto.randomUUID(), workspaceId: 1, baseUrl: 'http://localhost:11434/v1', policy: { reviewedOrigin: 'http://localhost:11434', allowHttp: true, allowPrivate: true }, apiKey: 'sk-test-secret' }, signal)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).not.toContain('sk-test-secret')
    })
})
