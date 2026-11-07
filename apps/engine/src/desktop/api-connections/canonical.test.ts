import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root: string
let canonicalDesktopApiConnectionAuthority: typeof import('./canonical.js')['canonicalDesktopApiConnectionAuthority']
let createDesktopApiConnectionService: typeof import('./service.js')['createDesktopApiConnectionService']
let memoryDesktopApiConnectionStore: typeof import('./store.js')['memoryDesktopApiConnectionStore']
beforeEach(async () => {
    vi.resetModules()
    root = await mkdtemp(join(tmpdir(), 'rerun-api-canonical-fixture-'))
    await mkdir(join(root, 'agents'))
    vi.stubEnv('RERUN_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '6'.repeat(64))
    vi.stubEnv('RERUN_API_KEY', '')
    vi.stubEnv('RERUN_HUB_BASE_URL', '')
    // Load the real store/provider graph as setup, before a test owns a deferred
    // effect. A cold module load must not leave a timed-out test continuing into
    // the next test's fresh environment and active mutation lease.
    ;({ canonicalDesktopApiConnectionAuthority } = await import('./canonical.js'))
    ;({ createDesktopApiConnectionService } = await import('./service.js'))
    ;({ memoryDesktopApiConnectionStore } = await import('./store.js'))
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it('holds the real connection lock through release/delete and refuses a queued legacy credential edit', async () => {
    const authority = canonicalDesktopApiConnectionAuthority({ workspaceId: 1, pendingRuns: async () => [], stopAndDrain: async () => {} })
    const id = 'cnx_fixture-locking'
    await authority.create({ name: 'Offline lock fixture', provider: 'openai', models: ['fixture-model'], extraModels: [], keys: { OPENAI_API_KEY: 'offline-fixture-only' } }, id)
    expect(authority.removalAvailable!()).toBe(true)
    let entered!: () => void
    let proceed!: () => void
    const locked = new Promise<void>(resolve => { entered = resolve })
    const hold = new Promise<void>(resolve => { proceed = resolve })
    const removal = authority.withRemoval!(id, async () => {
        entered()
        await hold
        await authority.release(id)
        await authority.delete(id)
    })
    // Observe refusal immediately instead of hanging on a gate the removal
    // could never enter (and leaving its rejection unhandled).
    await Promise.race([locked, removal.then(() => { throw new Error('Removal completed without entering its connection lock') })])
    let settled = false
    const queued = authority.updateKeys(id, { set: { OPENAI_API_KEY: 'offline-replacement-only' }, remove: [] })
        .then(() => ({ saved: true, error: null }), error => ({ saved: false, error }))
        .finally(() => { settled = true })
    try {
        await Promise.resolve()
        expect(settled).toBe(false)
    } finally { proceed() }
    await removal
    const result = await queued
    expect(result.saved).toBe(false)
    expect(result.error).toMatchObject({ status: 404 })
    expect(existsSync(join(root, 'connections', id))).toBe(false)
    expect(authority.removalAvailable!()).toBe(true)
})

it('serializes same-revision canonical mutations before either losing file effect can run', async () => {
    const authority = canonicalDesktopApiConnectionAuthority({ workspaceId: 1, pendingRuns: async () => [], stopAndDrain: async () => {} })
    const store = memoryDesktopApiConnectionStore()
    let sequence = 0
    const service = createDesktopApiConnectionService({ authority, store, connectionId: () => 'cnx_fixture-concurrent',
        revision: () => `rev_fixture-${String(++sequence).padStart(8, '0')}`, now: () => new Date('2026-11-06T00:00:00.000Z'), custodyKey: () => Buffer.alloc(32, 6) })
    const created = await service.create({ requestId: crypto.randomUUID(), workspaceId: 1, name: 'Before', provider: 'openai', models: ['fixture-model'], extraModels: [], secret: 'offline-original-key' })
    const id = created.connection!.connectionId, expectedRevision = created.connection!.revision
    let entered!: () => void
    let releaseFirst!: () => void
    let reservedSecond!: () => void
    const patchEntered = new Promise<void>(resolve => { entered = resolve })
    const holdPatch = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondReserved = new Promise<void>(resolve => { reservedSecond = resolve })
    const patch = authority.patch, updateKeys = authority.updateKeys, reserve = store.reserve
    let credentialEffects = 0
    authority.patch = async (connectionId, input) => { entered(); await holdPatch; return patch(connectionId, input) }
    authority.updateKeys = async (connectionId, input) => { credentialEffects++; return updateKeys(connectionId, input) }
    store.reserve = async (receipt, result) => { const reserved = await reserve(receipt, result); if (receipt.kind === 'credential') reservedSecond(); return reserved }

    const rename = service.rename({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: id, expectedRevision, name: 'Winner' })
    await patchEntered
    const credential = service.credential({ requestId: crypto.randomUUID(), workspaceId: 1, connectionId: id, expectedRevision, secret: 'offline-losing-key' })
    await secondReserved
    try {
        // Both requests have reached the service. Give the losing request a full
        // event-loop turn to expose a missing serialization boundary.
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(credentialEffects).toBe(0)
    } finally {
        releaseFirst()
        await Promise.allSettled([rename, credential])
    }
    const [winner, loser] = await Promise.all([rename, credential])
    expect(winner.status).toBe('saved')
    expect(loser.status).toBe('refused')
    expect(credentialEffects).toBe(0)
    const current = await authority.get(id)
    expect(current?.config.name).toBe('Winner')
    expect(current?.env.OPENAI_API_KEY).toBe('offline-original-key')
    expect(winner.catalog?.connections.find(connection => connection.connectionId === id)).toEqual(winner.connection)
    expect(await store.revision(1, id)).toBe(winner.receipt.connectionRevision)
})
