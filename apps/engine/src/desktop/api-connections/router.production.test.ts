import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { desktopRouteAllowed } from '../policy.js'
import { createDesktopApiConnectionRouter } from './router.js'

const boundary = vi.hoisted(() => ({ lists: 0, creates: [] as unknown[] }))
vi.mock('./runtime.js', () => ({ createDesktopApiConnectionRuntime: async () => ({
    list: async () => { boundary.lists++; return { version: 1, workspaceId: 1, connections: [], default: null } },
    create: async (input: unknown) => { boundary.creates.push(input); return { fixture: 'created' } },
}) }))
vi.mock('./run-authority.js', () => ({ pendingDesktopApiConnectionRuns: async () => [], stopAndDrainDesktopApiConnectionRuns: async () => {} }))

function mounted() {
    const app = new Hono()
    // Use the production allowlist and router together; neither is mocked.
    app.use('*', async (c, next) => desktopRouteAllowed(c.req.method, c.req.path) ? next() : c.json({ error: 'refused' }, 403))
    app.route('/desktop/api-connections', createDesktopApiConnectionRouter())
    return app
}
beforeEach(() => { vi.stubEnv('RERUN_DESKTOP_APP', '1'); vi.stubEnv('RERUN_DESKTOP_WORKSPACE_ID', '1'); boundary.lists = 0; boundary.creates = [] })
afterEach(() => vi.unstubAllEnvs())

it('admits the production catalog through the native policy and keeps workspace identity', async () => {
    const app = mounted()
    const response = await app.request('/desktop/api-connections/catalog?workspaceId=1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 1, workspaceId: 1, connections: [], default: null })
    expect((await app.request('/desktop/api-connections/catalog?workspaceId=2')).status).toBe(409)
    expect(boundary.lists).toBe(1)
})

it('admits exact named credential management but keeps unbound selection closed', async () => {
    const app = mounted()
    const input = { requestId: '00000000-0000-4000-8000-000000000001', workspaceId: 1, provider: 'openai', name: 'Offline fixture', models: ['fixture-model'], extraModels: [], secret: 'offline-fixture-only' }
    const response = await app.request('/desktop/api-connections/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    expect(response.status).toBe(200)
    expect(boundary.creates).toEqual([input])
    for (const path of ['/desktop/api-connections/select', '/desktop/api-connections/create/more']) {
        expect((await app.request(path, { method: 'POST' })).status).toBe(403)
    }
    expect(boundary.creates).toHaveLength(1)
})
