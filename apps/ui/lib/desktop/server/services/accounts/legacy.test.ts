import { createClient } from '@libsql/client'
import { afterEach, expect, it } from 'vitest'
import { desktopServicesSchema } from '../schema'
import { serviceStore, type ServiceInstall } from '../store'
import { serviceStoreInstalls } from './installs'
import { legacyCompatibleHeaderSecrets, sqliteHeaderSecrets } from './secret-store'
import { sqliteReservations } from './reservations'
import { accountHarness, bearerManifest } from './regression-harness'
import { accountLifecycle } from './lifecycle'

const clients: ReturnType<typeof createClient>[] = []
afterEach(() => { for (const db of clients.splice(0)) db.close() })

it('keeps a previous-version bearer connection configured without rewriting its ciphertext, then rotates it once', async () => {
    const db = createClient({ url: 'file::memory:' }); clients.push(db)
    await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('local-owner');" + desktopServicesSchema)
    const key = () => Buffer.alloc(32, 3), store = serviceStore(db, key)
    const h = accountHarness(), original = 'legacy-private-fixture'
    const row: ServiceInstall = {
        owner: h.binding.coworkerId, engineId: h.binding.engineOwnerId, key: 'fixture', id: h.requestId(), revision: h.requestId(),
        state: 'ready', plan: { slug: 'fixture', key: 'fixture', name: 'Fixture', category: 'dev', icon: null, methodId: 'token', serverName: 'fixture', url: 'https://example.com/mcp', secretInput: 'TOKEN', skills: [] },
        skills: [], toolNames: [], health: { state: 'unchecked' }, healthLaunch: null, installedAt: new Date().toISOString(), configured: true,
    }
    await db.execute({ sql: 'INSERT OR IGNORE INTO desktop_agents VALUES(?)', args: [row.owner] })
    await store.create(row, original)
    const before = (await db.execute('SELECT bearer FROM desktop_service_installs')).rows[0].bearer
    const secrets = legacyCompatibleHeaderSecrets(store, sqliteHeaderSecrets(db, key))
    h.manifests.fixture = bearerManifest()
    const deps = { ...h.deps, installs: serviceStoreInstalls(store), secrets, reservations: sqliteReservations(db) }
    const life = accountLifecycle(deps)
    const views = await life.list(h.binding, h.signal())
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ installationId: row.id, revision: row.revision, shape: 'bearer', configured: true, configuredInputs: { TOKEN: true } })
    expect(JSON.stringify(views)).not.toContain(original)
    expect((await db.execute('SELECT bearer FROM desktop_service_installs')).rows[0].bearer).toBe(before)
    expect(await secrets.read(row.owner, row.id, row.revision)).toEqual({ headers: { Authorization: `Bearer ${original}` }, inputs: { TOKEN: original } })
    const input = { action: 'reconfigure' as const, requestId: h.requestId(), intent: { kind: 'existing' as const, accountKey: row.key, expectedRevision: row.revision }, authMethodId: 'token', values: { TOKEN: '' } }
    const saved = await life.mutate(h.binding, input, h.signal())
    expect(saved.installationId).toBe(row.id)
    expect(saved.revision).not.toBe(row.revision)
    expect(await store.credential(row.owner, row.id)).toBe(original)
    expect((await secrets.read(row.owner, row.id, saved.revision!))?.inputs.TOKEN).toBe(original)
    expect(await secrets.read(row.owner, row.id, row.revision)).toBeNull()
    expect((await accountLifecycle(deps).mutate(h.binding, input, h.signal())).revision).toBe(saved.revision)
    expect(await store.list(row.owner)).toHaveLength(1)
    expect(h.networkCalls).toHaveLength(0)
})
