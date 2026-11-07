import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root: string
const namedId = 'cnx_fixture-guarded', legacyId = 'legacy-openai', model = 'fixture-model'
beforeEach(async () => {
    vi.resetModules()
    root = await mkdtemp(join(tmpdir(), 'rerun-named-route-fixture-'))
    await mkdir(join(root, 'agents'))
    vi.stubEnv('RERUN_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '7'.repeat(64))
    vi.stubEnv('RERUN_API_KEY', '')
    vi.stubEnv('RERUN_HUB_BASE_URL', '')
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function fixture() {
    const { connectionRoutes } = await import('./connections.js')
    const { desktopRouteAllowed } = await import('../../desktop/policy.js')
    const store = await import('../../connections/store.js')
    const registry = await import('../../connections/registry.js')
    const defaults = await import('../../connections/default.js')
    for (const id of [namedId, legacyId]) await store.createConnection({ name: id, provider: 'openai', models: [model], extraModels: [], keys: { OPENAI_API_KEY: 'offline-original-key' } }, id)
    await defaults.writeBoxDefault({ connectionId: legacyId, model })
    const native = new Hono()
    native.use('*', async (c, next) => desktopRouteAllowed(c.req.method, c.req.path) ? next() : c.json({ error: 'native policy refusal' }, 403))
    native.route('/connections', connectionRoutes)
    const generic = new Hono().route('/connections', connectionRoutes)
    return { native, generic, registry, defaults }
}
const request = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

it('refuses named mutation aliases at both native policy and decoded generic Hono handlers without effects', async () => {
    const f = await fixture()
    for (const alias of [namedId, namedId.toUpperCase(), '%63nx_fixture-guarded', 'cnx%5ffixture-guarded', 'cnx_fixture%2dguarded']) {
        for (const suffix of ['', '/keys']) {
            const path = `/connections/${alias}${suffix}`
            expect((await f.native.request(path, request('PATCH', suffix ? { set: { OPENAI_API_KEY: 'offline-forbidden-key' } } : { name: 'Forbidden' }))).status).toBe(403)
            expect((await f.generic.request(path, request('PATCH', suffix ? { set: { OPENAI_API_KEY: 'offline-forbidden-key' } } : { name: 'Forbidden' }))).status).toBe(409)
        }
        expect((await f.native.request(`/connections/${alias}`, { method: 'DELETE' })).status).toBe(403)
        expect((await f.generic.request(`/connections/${alias}`, { method: 'DELETE' })).status).toBe(409)
    }
    const current = await f.registry.getConnection(namedId)
    expect(current.config.name).toBe(namedId)
    expect(current.env.OPENAI_API_KEY).toBe('offline-original-key')
    expect(existsSync(join(root, 'connections', namedId))).toBe(true)
    expect(await f.defaults.readBoxDefault()).toEqual({ connectionId: legacyId, model })
})

it('keeps named default selection closed while preserving valid legacy API settings', async () => {
    const f = await fixture()
    for (const connectionId of [namedId, namedId.toUpperCase()]) {
        expect((await f.native.request('/connections/default', request('PUT', { connectionId, model }))).status).toBe(409)
        expect((await f.generic.request('/connections/default', request('PUT', { connectionId, model }))).status).toBe(409)
    }
    expect((await f.native.request(`/connections/${legacyId}`, request('PATCH', { name: 'Legacy renamed' }))).status).toBe(200)
    expect((await f.native.request(`/connections/${legacyId}/keys`, request('PATCH', { set: { OPENAI_API_KEY: 'offline-legacy-replacement' } }))).status).toBe(200)
    expect((await f.native.request('/connections/default', request('PUT', { connectionId: legacyId, model }))).status).toBe(200)
    const legacy = await f.registry.getConnection(legacyId)
    expect(legacy.config.name).toBe('Legacy renamed')
    expect(legacy.env.OPENAI_API_KEY).toBe('offline-legacy-replacement')
    expect((await f.registry.getConnection(namedId)).env.OPENAI_API_KEY).toBe('offline-original-key')
    expect(await f.defaults.readBoxDefault()).toEqual({ connectionId: legacyId, model })
})
