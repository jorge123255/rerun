import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteMcpSchema, remoteMcpOAuthSchema, remoteMcpStore, bindRemoteTransportDrain } from '../mcp/store'
import { migrateDesktopSse } from './schema'
import { createSseSettings } from './settings'

const resources: Array<{ db: Client; folder: string }> = []
afterEach(async () => { for (const item of resources.splice(0)) { item.db.close(); await rm(item.folder, { recursive: true, force: true }) } })
async function fixture() {
    const folder = await mkdtemp(join(tmpdir(), 'sse-settings-'))
    const db = createClient({ url: `file:${join(folder, 'app.db')}` }); resources.push({ db, folder })
    await db.executeMultiple("PRAGMA foreign_keys=ON; CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner');" + remoteMcpSchema + remoteMcpOAuthSchema)
    await migrateDesktopSse(db)
    const store = remoteMcpStore(db, () => Buffer.alloc(32, 1)), drain = vi.fn(async () => {})
    let generation = 0
    const authorize = async (owner: string, signal: AbortSignal) => {
        if (owner !== 'owner') throw new Error('wrong owner')
        const epoch = generation
        return () => { signal.throwIfAborted(); if (epoch !== generation) throw new Error('owner changed') }
    }
    const settings = createSseSettings(db, store, authorize, drain)
    const input = { kind: 'save' as const, agentId: 'owner', requestId: crypto.randomUUID(), serverId: null, expectedRevision: null, configuration: { name: 'fixture', transport: 'sse' as const, url: 'https://example.com/sse' } }
    return { db, store, settings, authorize, drain, input, signal: new AbortController().signal, revoke: () => { generation++ } }
}

it('coalesces two settings services and recovers the same immutable server identity', async () => {
    const f = await fixture(), second = createSseSettings(f.db, f.store, f.authorize, f.drain)
    const [a, b] = await Promise.all([f.settings.mutate(f.input, f.signal), second.mutate(f.input, f.signal)])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ status: 'saved', reference: { agentId: 'owner', name: 'fixture' } })
    expect(await second.reconcile('owner', f.input.requestId, f.signal)).toEqual(a)
    expect(await f.store.list('owner')).toHaveLength(1)
    expect((await f.store.list('owner'))[0].transport).toBe('sse')
    await expect(second.mutate({ ...f.input, configuration: { ...f.input.configuration, name: 'replacement' } }, f.signal)).rejects.toThrow()
})

it('an interrupted claim recovers its reserved identity rather than creating another server', async () => {
    const f = await fixture()
    f.drain.mockRejectedValueOnce(new Error('close unconfirmed'))
    await expect(f.settings.mutate(f.input, f.signal)).rejects.toThrow('close unconfirmed')
    const reserved = (await f.db.execute('SELECT server_id,revision,result FROM desktop_mcp_sse_settings')).rows[0]
    expect(reserved.result).toBeNull()
    expect(await f.store.list('owner')).toEqual([])
    const recovered = await createSseSettings(f.db, f.store, f.authorize, f.drain).reconcile('owner', f.input.requestId, f.signal)
    expect(recovered).toMatchObject({ status: 'saved', reference: { serverId: reserved.server_id, expectedRevision: reserved.revision } })
    expect(await f.store.list('owner')).toHaveLength(1)
})

it('lost commit acknowledgement is recovered from the atomic configuration receipt', async () => {
    const f = await fixture(), transaction = f.db.transaction.bind(f.db)
    const spy = vi.spyOn(f.db, 'transaction').mockImplementation(async () => {
        const tx = await transaction('write')
        return new Proxy(tx, { get(target, key) {
            if (key === 'commit') return async () => { await target.commit(); throw new Error('ack lost') }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
        } })
    })
    await expect(f.settings.mutate(f.input, f.signal)).rejects.toThrow()
    spy.mockRestore()
    expect(await f.settings.reconcile('owner', f.input.requestId, f.signal)).toMatchObject({ status: 'saved' })
    expect(await f.store.list('owner')).toHaveLength(1)
    expect(f.drain).toHaveBeenCalledTimes(1)
})

it('old management cannot change an SSE endpoint or delete it, while an exact bearer edit drains its connection', async () => {
    const f = await fixture(), saved = await f.settings.mutate(f.input, f.signal)
    if (saved.status !== 'saved' || !saved.reference) throw new Error('not saved')
    const ref = saved.reference
    await expect(f.store.save('owner', { name: ref.name, url: f.input.configuration.url, revision: ref.expectedRevision, bearer: 'private-fixture' })).rejects.toThrow()
    bindRemoteTransportDrain(f.store, f.drain)
    await expect(f.store.save('owner', { name: ref.name, url: 'https://other.example/sse', revision: ref.expectedRevision, bearer: 'private-fixture' })).rejects.toThrow()
    await expect(f.store.remove('owner', ref.name, ref.expectedRevision)).rejects.toThrow()
    const rows = await f.store.save('owner', { name: ref.name, url: f.input.configuration.url, revision: ref.expectedRevision, bearer: 'private-fixture' })
    expect(rows[0]).toMatchObject({ id: ref.serverId, transport: 'sse', hasBearer: true })
    expect(rows[0].revision).not.toBe(ref.expectedRevision)
    expect(JSON.stringify(rows)).not.toContain('private-fixture')
    expect(f.drain).toHaveBeenLastCalledWith('owner', ref.name)
})

it('revocation during cleanup prevents publication, and an exact delete keeps another server', async () => {
    const f = await fixture()
    f.drain.mockImplementationOnce(async () => { f.revoke() })
    await expect(f.settings.mutate(f.input, f.signal)).rejects.toThrow('owner changed')
    expect(await f.store.list('owner')).toEqual([])
    const saved = await f.settings.reconcile('owner', f.input.requestId, f.signal)
    if (saved.status !== 'saved' || !saved.reference) throw new Error('not saved')
    await f.store.save('owner', { name: 'sibling', url: 'https://example.com/mcp' })
    const deletion = { kind: 'delete' as const, agentId: 'owner', requestId: crypto.randomUUID(), reference: saved.reference }
    expect(await f.settings.mutate(deletion, f.signal)).toMatchObject({ status: 'saved' })
    expect(await f.settings.reconcile('owner', deletion.requestId, f.signal)).toMatchObject({ status: 'saved' })
    expect((await f.store.list('owner')).map(row => row.name)).toEqual(['sibling'])
})
