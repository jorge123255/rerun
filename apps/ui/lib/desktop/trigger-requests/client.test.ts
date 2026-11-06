import { describe, expect, it, vi } from 'vitest'
import { createTriggerRequestsClient } from './client'
import { testTriggerView as view } from './fixtures.test-support'

describe('private webhook request transport', () => {
    it('uses authenticated same-origin GET and never fires on restore', async () => {
        const transport = vi.fn<typeof fetch>(async () => Response.json({ request: view }))
        const client = createTriggerRequestsClient(view.link.sessionId, view.key, transport)
        expect(await client.read()).toEqual(view)
        expect(transport).toHaveBeenCalledTimes(1)
        expect(transport.mock.calls[0][0]).toContain('/trigger-requests?key=')
        expect(transport.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
        expect(JSON.stringify(transport.mock.calls)).not.toContain('trigger-ingress')
    })
    it('rejects cross-chat and stale-key responses', async () => {
        for (const foreign of [{ ...view, key: 'c'.repeat(64) }, { ...view, link: { ...view.link, sessionId: 'private-chat' } }]) {
            const client = createTriggerRequestsClient(view.link.sessionId, view.key, vi.fn(async () => Response.json({ request: foreign })))
            await expect(client.read()).rejects.toThrow('another conversation')
        }
    })
    it('does not expose private server errors and does not retry a rejected decision', async () => {
        const transport = vi.fn(async () => Response.json({ error: 'token=private-value' }, { status: 409 }))
        const client = createTriggerRequestsClient(view.link.sessionId, view.key, transport)
        await expect(client.decide({ kind: 'question', input: { action: 'cancel', questionId: view.link.requestId, requestId: crypto.randomUUID() } })).rejects.toThrow('saved request changed')
        expect(transport).toHaveBeenCalledTimes(1)
    })
    it('refuses malformed or oversized authenticated projections', async () => {
        const transport = vi.fn<typeof fetch>(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)))
        await expect(createTriggerRequestsClient(view.link.sessionId, view.key, transport).read()).rejects.toThrow('too large')
    })
})
