import { expect, test, vi } from 'vitest'
import { createDesktopForemanBridge } from './bridge.js'
const runtime = { launchNonce: '00000000-0000-4000-8000-000000000001', app: { origin: 'http://127.0.0.1:44000' }, engine: { apiKey: 'a'.repeat(64) } }
test('bridge pins the app origin, current launch and credential without following redirects', async () => {
    const network = vi.fn(async () => Response.json({ ok: true })) as typeof fetch
    const bridge = createDesktopForemanBridge(runtime, network)
    await bridge.request({ action: 'binding', identity: { engineAgentId: 'foreman', sessionId: 's', runId: 'r' } })
    expect(network).toHaveBeenCalledWith('http://127.0.0.1:44000/api/desktop/internal/foreman', expect.objectContaining({ redirect: 'error', credentials: 'omit', headers: expect.objectContaining({ authorization: `Bearer ${runtime.engine.apiKey}` }), body: expect.stringContaining(runtime.launchNonce) }))
    bridge.close()
    await expect(bridge.request({ action: 'binding', identity: { engineAgentId: 'foreman', sessionId: 's', runId: 'r' } })).rejects.toThrow()
    expect(network).toHaveBeenCalledTimes(1)
    for (const origin of ['https://example.com', 'http://localhost:44000', 'http://127.0.0.1:44000/path', 'http://x@127.0.0.1:44000']) expect(() => createDesktopForemanBridge({ ...runtime, app: { origin } }, network)).toThrow()
})
test('unknown acknowledgements and oversized responses do not authorize another effect', async () => {
    const identity = { engineAgentId: 'foreman' as const, sessionId: 's', runId: 'r' }
    const unavailable = createDesktopForemanBridge(runtime, vi.fn(async () => new Response('unavailable', { status: 409 })) as typeof fetch)
    await expect(unavailable.binding(identity)).rejects.toThrow()
    const oversized = createDesktopForemanBridge(runtime, vi.fn(async () => new Response('x'.repeat(65_537))) as typeof fetch)
    await expect(oversized.binding(identity)).rejects.toThrow('limit')
    const unexpected = createDesktopForemanBridge(runtime, vi.fn(async () => Response.json({ binding: {}, discovery: true })) as typeof fetch)
    await expect(unexpected.binding(identity)).rejects.toThrow()
})
