import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { POST } from './route'

const state = vi.hoisted(() => ({ runtime: vi.fn() }))
vi.mock('@/lib/desktop/server/runtime', async original => ({ ...await original<typeof import('@/lib/desktop/server/runtime')>(), readDesktopRuntime: state.runtime }))

const runtime: DesktopRuntime = {
    protocolVersion: 1, workspaceId: 1, dataRoot: '/isolated-fixture', buildId: 'fixture', launchNonce: 'fixture-launch',
    app: { origin: 'http://127.0.0.1:32111', sessionToken: 'x'.repeat(48) }, engine: { origin: 'http://127.0.0.1:32112', apiKey: 'fixture-engine-key' },
}
const payload = { action: 'read', identity: { workspaceId: 1, connectionId: 'fixture-connection', revision: 2 } }
const request = (cookie: string, contentType = 'application/json') => new Request(`${runtime.app.origin}/api/desktop/custom-providers`, {
    method: 'POST', headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin, cookie, 'content-type': contentType },
    body: JSON.stringify(payload),
})

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

test('the browser surface requires its local session, JSON and the current launch before proxying', async () => {
    const engine = vi.fn(async () => Response.json({ error: 'Custom connection changed.' }, { status: 409 }))
    vi.stubGlobal('fetch', engine)
    state.runtime.mockResolvedValue(runtime)
    const cookie = `rerun-desktop-session=${runtime.app.sessionToken}`
    expect((await POST(request(''))).status).toBe(401)
    expect((await POST(request(cookie, 'text/plain'))).status).toBe(415)
    state.runtime.mockResolvedValueOnce(runtime).mockResolvedValueOnce({ ...runtime, launchNonce: 'new-launch' })
    expect((await POST(request(cookie))).status).toBe(409)
    expect(engine).not.toHaveBeenCalled()
    const response = await POST(request(cookie))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Custom connection changed.' })
    expect(engine).toHaveBeenCalledExactlyOnceWith(new URL('/desktop/custom-providers', runtime.engine.origin), expect.objectContaining({
        redirect: 'error', body: JSON.stringify(payload),
        headers: expect.objectContaining({ authorization: 'Bearer fixture-engine-key', 'x-rerun-launch-nonce': runtime.launchNonce }),
    }))
})
