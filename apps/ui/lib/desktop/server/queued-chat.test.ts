import { afterEach, expect, test, vi } from 'vitest'
import { startQueuedChat } from './queued-chat'

afterEach(() => vi.unstubAllGlobals())

test('only transient run_in_flight responses retry the same stable queued request', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return bodies.length === 1 ? Response.json({ code: 'run_in_flight' }, { status: 409 }) : new Response('accepted')
    }))
    const params = { sessionId: 'session', message: 'Follow-up', desktopQueuedTurn: { runId: crypto.randomUUID() } }
    expect((await startQueuedChat({ baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture' }, 'agent', params, [0])).status).toBe(200)
    expect(bodies).toEqual([params, params])
    const conflict = vi.fn(async () => Response.json({ error: 'Different message' }, { status: 409 }))
    vi.stubGlobal('fetch', conflict)
    expect((await startQueuedChat({ baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture' }, 'agent', params, [0, 0])).status).toBe(409)
    expect(conflict).toHaveBeenCalledTimes(1)
})
