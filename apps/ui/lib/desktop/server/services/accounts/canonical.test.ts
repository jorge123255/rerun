import { createClient } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '../../runtime'
import type { ServiceRun } from '../lifecycle'
import type { AccountFeature } from './feature'
import type { DesktopServiceAccountMutation } from '@rerun/contracts'

vi.mock('server-only', () => ({}))
const fixture = vi.hoisted(() => ({ db: undefined as unknown, manifest: undefined as unknown, losePublication: false }))
vi.mock('../../database', () => ({ openDesktopDatabase: async () => fixture.db }))
vi.mock('../../store', () => ({ findDesktopAgent: async (_db: unknown, id: string) => id === 'owner' ? { id, engineAgentId: 'engine' } : null }))
vi.mock('../catalog/index', () => ({
    getDesktopServiceManifest: () => ({ manifest: fixture.manifest }),
    listDesktopServiceCatalog: () => ({ services: [], total: 0 }),
    getDesktopServiceMethodAvailability: (_slug: string, id: string) => ({ id, supported: true }),
}))
vi.mock('../skill-resources', async importOriginal => {
    const original = await importOriginal<typeof import('../skill-resources')>()
    return { ...original,
        verifyServiceSkill: vi.fn<typeof original.verifyServiceSkill>(async () => {}),
        removeServiceSkill: vi.fn<typeof original.removeServiceSkill>(async (_root, _owned, guard) => { await guard() }),
        resolveServiceSkillRemoval: vi.fn<typeof original.resolveServiceSkillRemoval>(async (_root, reservation, guard) => { await guard(); if (!reservation.resource) throw new Error('Missing resource'); return reservation.resource }),
        createServiceSkill: vi.fn<typeof original.createServiceSkill>(async (_root, record, index, skill, guard, journal) => {
            await guard()
            const reservation = await journal.reserve(record, index, original.serviceSkillHash(skill))
            if (reservation.resource) return reservation.resource
            const resource = { slug: reservation.slug, directoryIdentity: `1:${parseInt(record.id.replaceAll('-', '').slice(0, 12), 16) + index}`, manifestVersion: '1:2:3:4:5', contentHash: reservation.hash }
            await journal.update(reservation, 'published', resource)
            if (fixture.losePublication) { fixture.losePublication = false; throw new Error('Lost publication acknowledgement') }
            return resource
        }),
    }
})

import { serviceManifestSchema } from '@/lib/services/manifest'
import { desktopServicesSchema } from '../schema'
import { serviceStore } from '../store'
import { serviceSkillMigrationSql } from '../skill-journal'
import { localServiceLifecycle } from '../lifecycle'
import { removeServiceSkill } from '../skill-resources'
import { canonicalServiceAccounts } from './canonical'
import { sqliteHeaderSecrets } from './secret-store'
import { mcpResponse } from './regression-harness'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.unstubAllGlobals(); vi.clearAllMocks(); fixture.losePublication = false })
const signal = () => new AbortController().signal
const run: ServiceRun = { engineAgentId: 'engine', sessionId: 'session', runId: 'run' }
const install = (kind: 'new' | 'additional' = 'new', token = 'private-fixture-token'): DesktopServiceAccountMutation => ({ action: 'install', requestId: crypto.randomUUID(), intent: { kind, slug: 'fixture' }, authMethodId: 'key', values: { TOKEN: token } })

async function setup(withSkills = false) {
    const db = createClient({ url: 'file::memory:' })
    await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner');" + desktopServicesSchema + ';' + serviceSkillMigrationSql)
    fixture.db = db
    fixture.manifest = serviceManifestSchema.parse({ slug: 'fixture', name: 'Fixture', category: 'dev', multiInstance: true,
        skills: withSkills ? [{ name: 'Usage', body: 'Use the fixture carefully.' }] : [],
        authMethods: [{ id: 'key', kind: 'key', inputs: [{ key: 'TOKEN', label: 'Token', type: 'password', secret: true, required: true }], mcpServers: [{ name: 'fixture', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-Api-Key': 'Token ${input.TOKEN}' } }] }],
    })
    const runtime: DesktopRuntime = { protocolVersion: 1, dataRoot: '/fixture', workspaceId: 1, launchNonce: 'launch-1', buildId: 'fixture', app: { origin: 'http://127.0.0.1:3100', sessionToken: 'fixture-session' }, engine: { origin: 'http://127.0.0.1:3101', apiKey: 'fixture-engine' } }
    const store = serviceStore(db, () => Buffer.alloc(32, 7)), syncRegistry = vi.fn(async () => {})
    let granted = true, running = true
    const observed: Array<{ method: string; headers: Headers }> = []
    let intercept: ((method: string) => Promise<void>) | undefined
    const network = vi.fn(async (url: string, init: RequestInit) => {
        const method = init.method === 'DELETE' ? 'DELETE' : JSON.parse(String(init.body)).method as string
        observed.push({ method, headers: new Headers(init.headers) })
        await intercept?.(method)
        return mcpResponse(url, init)
    })
    vi.stubGlobal('fetch', network)
    const createService = () => localServiceLifecycle(store, async (owner, _action, identity, stop) => {
        stop.throwIfAborted()
        if (owner !== 'owner' || identity && (identity.engineAgentId !== run.engineAgentId || identity.sessionId !== run.sessionId || identity.runId !== run.runId || !running)) throw new Error('Run is no longer active')
        return { engineAgentId: 'engine', runtime, skillsRoot: '/fixture/skills', enabled: true, granted }
    }, async () => {}, network as typeof fetch, syncRegistry)
    let services = createService(), feature: AccountFeature = await canonicalServiceAccounts(runtime, store, services, () => Buffer.alloc(32, 7))
    closers.push(async () => { services.shutdown(); await services.drain(); db.close() })
    return {
        db, store, observed, syncRegistry, secrets: sqliteHeaderSecrets(db, () => Buffer.alloc(32, 7)),
        get services() { return services }, get feature() { return feature },
        revoke: () => { granted = false }, stopRun: () => { running = false },
        intercept: (fn: (method: string) => Promise<void>) => { intercept = fn },
        async restart() {
            services.shutdown(); await services.drain(); runtime.launchNonce = 'launch-2'
            services = createService()
            feature = await canonicalServiceAccounts(runtime, store, services, () => Buffer.alloc(32, 7))
            await services.reconcileOwners(signal())
        },
    }
}

it('uses canonical account credentials, tool authority and skill journal for an additional account', async () => {
    const h = await setup(true)
    const first = await h.feature.mutate('owner', install(), signal())
    const second = await h.feature.mutate('owner', install('additional', 'second-fixture-token'), signal())
    expect(second.accountKey).not.toBe(first.accountKey)
    const record = (await h.store.read('owner', second.accountKey!))!
    const reservations = await h.services.skillJournal.list('owner')
    expect(reservations.filter(row => row.installationId === record.id)).toMatchObject([{ state: 'acknowledged', resource: record.skills[0] }])
    await h.services.discover(record, run, signal())
    const connection = h.services.transport(record, run, signal())
    const output = await connection.call('owner', h.services.idName(record), record.revision, 'echo', {}, signal())
    expect(JSON.stringify(output)).not.toContain('second-fixture-token')
    expect(h.observed.filter(row => row.method !== 'DELETE').every(row => row.headers.get('X-Api-Key') === 'Token second-fixture-token')).toBe(true)
    await expect(h.services.mutate('owner', { action: 'disconnect', requestId: crypto.randomUUID(), key: record.key, expectedRevision: record.revision }, signal())).rejects.toThrow('account settings')
    expect((await h.store.read('owner', record.key))?.revision).toBe(record.revision)
})

it('keeps a sealed partial install revision and bundle across restart and resumes its exact request', async () => {
    const h = await setup(true), input = install()
    fixture.losePublication = true
    await expect(h.feature.mutate('owner', input, signal())).rejects.toThrow('Lost publication')
    const partial = (await h.store.read('owner', 'fixture'))!
    expect(partial.state).toBe('preparing'); expect(partial.skills).toEqual([])
    const before = await h.secrets.read('owner', partial.id, partial.revision)
    await h.restart()
    expect(await h.store.read('owner', 'fixture')).toMatchObject({ id: partial.id, revision: partial.revision, state: 'preparing' })
    expect(await h.secrets.read('owner', partial.id, partial.revision)).toEqual(before)
    const resumed = await h.feature.mutate('owner', input, signal())
    expect(resumed).toMatchObject({ installationId: partial.id, revision: partial.revision })
    expect(await h.services.skillJournal.list('owner')).toMatchObject([{ state: 'acknowledged' }])
    expect(h.observed).toHaveLength(0)
})

it('removes a journaled skill that was published before its row projection, preserving a sibling', async () => {
    const h = await setup(true)
    const base = await h.feature.mutate('owner', install(), signal())
    fixture.losePublication = true
    await expect(h.feature.mutate('owner', install('additional'), signal())).rejects.toThrow('Lost publication')
    const partial = (await h.store.list('owner')).find(row => row.id !== base.installationId)!
    expect(partial.skills).toEqual([])
    await h.restart()
    const result = await h.feature.mutate('owner', { action: 'remove', requestId: crypto.randomUUID(), intent: { kind: 'existing', accountKey: partial.key, expectedRevision: partial.revision } }, signal())
    expect(result.status).toBe('removed')
    expect(removeServiceSkill).toHaveBeenCalledTimes(1)
    expect(await h.store.read('owner', partial.key)).toBeNull()
    expect(await h.store.read('owner', base.accountKey!)).toMatchObject({ id: base.installationId, revision: base.revision })
    expect((await h.services.skillJournal.list('owner')).find(row => row.installationId === partial.id)?.state).toBe('removed')
})

it('rejects a tool call with no exact active run and stops publication when the run changes during RPC', async () => {
    const h = await setup(), saved = await h.feature.mutate('owner', install(), signal())
    const record = (await h.store.read('owner', saved.accountKey!))!
    await h.services.discover(record, run, signal())
    h.observed.length = 0
    await expect(h.services.transport(record, undefined, signal()).call('owner', h.services.idName(record), record.revision, 'echo', {}, signal())).rejects.toThrow('current chat run')
    expect(h.observed).toHaveLength(0)
    h.intercept(async method => { if (method === 'tools/call') h.stopRun() })
    await expect(h.services.transport(record, run, signal()).call('owner', h.services.idName(record), record.revision, 'echo', {}, signal())).rejects.toThrow()
    expect(h.observed.filter(row => row.method === 'tools/call')).toHaveLength(1)
})

it('serializes settings with owner transitions and waits for their real work before deletion', async () => {
    const h = await setup()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const order: string[] = []
    const mutation = h.services.accountMutation('owner', false, async () => { order.push('mutation'); entered(); await gate; order.push('finished') })
    await started
    const transition = h.services.transitionOwner('owner', async () => { order.push('owner-write') })
    await Promise.resolve(); expect(order).toEqual(['mutation'])
    release(); await Promise.all([mutation, transition])
    expect(order).toEqual(['mutation', 'finished', 'owner-write'])
})

it('quarantines an unreadable installation without accepting its version or stopping unrelated startup', async () => {
    const h = await setup(), revision = crypto.randomUUID()
    await h.db.execute({ sql: `INSERT INTO desktop_service_installs(owner,key,id,schema_version,engine_id,slug,method_id,revision,state,plan,health,installed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, args: ['owner', 'unknown', crypto.randomUUID(), 2, 'engine', 'unknown', 'default', revision, 'ready', '{}', '{"state":"unchecked"}', new Date().toISOString()] })
    await expect(h.services.reconcileOwners(signal())).resolves.toBeUndefined()
    const row = (await h.db.execute("SELECT revision,schema_version,health FROM desktop_service_installs WHERE key='unknown'")).rows[0]
    expect(row.revision).toBe(revision)
    expect(row.schema_version).toBe(2)
    expect(JSON.parse(String(row.health))).toMatchObject({ state: 'error' })
    await expect(h.store.read('owner', 'unknown')).rejects.toThrow('Unsupported service installation version')
    expect(h.observed).toHaveLength(0)
})
