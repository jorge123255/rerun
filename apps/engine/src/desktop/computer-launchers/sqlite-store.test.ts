import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { LauncherAttempt } from './ports.js'
import { computerLauncherSchema, sqliteLauncherStore } from './sqlite-store.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const attempt = (requestId = 'call'): LauncherAttempt => ({ version: 1, operation: { requestId, agentId: 'owner', sessionId: 'session', runId: 'run', generation: 'a'.repeat(32), app: 'terminal' }, fingerprint: 'b'.repeat(64), operationId: 'c'.repeat(64), phase: 'reserved', outcome: null })
async function database() {
    const directory = await mkdtemp(join(tmpdir(), 'rerun-launcher-ledger-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const url = `file:${join(directory, 'ledger.db')}`
    const db = createClient({ url }); cleanup.push(() => db.close())
    await db.execute(computerLauncherSchema)
    return { db, url, store: sqliteLauncherStore(db) }
}
it('preserves submitted identity across a closed database and restart without fresh reservation', async () => {
    const f = await database(), first = attempt()
    expect((await f.store.reserve(first)).created).toBe(true)
    await f.store.submitted(first)
    f.db.close()
    const reopened = createClient({ url: f.url }); cleanup.push(() => reopened.close())
    const store = sqliteLauncherStore(reopened)
    const found = await store.reserve(first)
    expect(found).toEqual({ created: false, attempt: { ...first, phase: 'submitted' } })
    await store.settle(first, { requestId: 'call', app: 'terminal', status: 'opened', acknowledged: true })
    expect((await store.reserve(first)).attempt.phase).toBe('settled')
    expect(String((await reopened.execute('SELECT record FROM desktop_computer_launcher_attempts')).rows[0]?.record)).not.toContain('screenshot')
})
it('retains the original request on identity conflict and rejects another fingerprint writing it', async () => {
    const { store } = await database(), first = attempt()
    await store.reserve(first)
    const replacement = { ...first, fingerprint: 'd'.repeat(64), operation: { ...first.operation, agentId: 'other', runId: 'other-run' } }
    expect((await store.reserve(replacement)).attempt).toEqual(first)
    await expect(store.submitted(replacement)).rejects.toThrow('identity conflict')
    await expect(store.settle(replacement, { requestId: 'call', app: 'terminal', status: 'focused', acknowledged: true })).rejects.toThrow('identity conflict')
    expect((await store.reserve(first)).attempt).toEqual(first)
})
it('fails closed on corrupt and unsupported durable records rather than replacing their tombstone', async () => {
    const { db, store } = await database(), first = attempt()
    await store.reserve(first)
    for (const record of ['{broken', JSON.stringify({ ...first, version: 2 }), JSON.stringify({ ...first, frame: 'old-frame' })]) {
        await db.execute({ sql: 'UPDATE desktop_computer_launcher_attempts SET record=?', args: [record] })
        await expect(store.reserve(first)).rejects.toThrow()
        expect((await db.execute('SELECT record FROM desktop_computer_launcher_attempts')).rows[0]?.record).toBe(record)
    }
})
it('reserves exactly once under concurrent requests and keeps terminal receipts when bounded', async () => {
    const { db, store } = await database(), first = attempt()
    const results = await Promise.all([store.reserve(first), store.reserve(first)])
    expect(results.filter(result => result.created)).toHaveLength(1)
    await db.batch(Array.from({ length: 255 }, (_, index) => ({ sql: 'INSERT INTO desktop_computer_launcher_attempts(key,owner,generation,record) VALUES(?,?,?,?)', args: [`computer-launcher:fixture-${index}`, 'owner', first.operation.generation, JSON.stringify(attempt(`fixture-${index}`))] })), 'write')
    await expect(store.reserve(attempt('extra'))).rejects.toThrow('receipt limit')
    expect((await store.reserve(first)).created).toBe(false)
    expect(Number((await db.execute('SELECT COUNT(*) AS n FROM desktop_computer_launcher_attempts')).rows[0]?.n)).toBe(256)
})
