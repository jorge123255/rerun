import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createFxCameraWorkspaceStore, FX_BOARD_CAMERA_SCHEMA_SQL } from './board-camera-store'
const clients: Client[] = [], directories: string[] = []
afterEach(async () => { for (const client of clients.splice(0)) client.close(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
const camera = { pan: { x: -90, y: 87 }, zoom: 0.8 }, requestId = '00000000-0000-4000-8000-000000000001'
test('real SQLite store survives reopen, isolates workspaces, reconciles the same request and refuses stale overwrites', async () => {
    const path = await mkdtemp(join(tmpdir(), 'fx-camera-fixture-')); directories.push(path)
    const url = `file:${join(path, 'fixture.db')}`, db = createClient({ url }); clients.push(db)
    await db.executeMultiple(FX_BOARD_CAMERA_SCHEMA_SQL) // Offline fixture migration, authored and unrun.
    const one = createFxCameraWorkspaceStore(db, 1), two = createFxCameraWorkspaceStore(db, 2), signal = new AbortController().signal
    const input = { workspaceId: 1, requestId, expectedRevision: 0, camera }
    expect((await one.read()).camera).toBeNull()
    expect(await one.write(input, signal)).toEqual(await one.write(input, signal))
    expect((await one.read()).revision).toBe(1); expect((await two.read()).camera).toBeNull()
    await expect(two.write(input, signal)).rejects.toThrow('Workspace changed')
    await expect(one.write({ ...input, camera: { ...camera, zoom: 1 } }, signal)).rejects.toThrow('exact board view request')
    expect((await one.write({ ...input, requestId: '00000000-0000-4000-8000-000000000002' }, signal)).status).toBe('conflict')
    db.close(); clients.splice(clients.indexOf(db), 1)
    const reopened = createClient({ url }); clients.push(reopened)
    expect(await createFxCameraWorkspaceStore(reopened, 1).read()).toEqual({ workspaceId: 1, revision: 1, camera })
})
test('missing migration is unavailable, not an empty successful read or an automatic repair', async () => {
    const path = await mkdtemp(join(tmpdir(), 'fx-camera-missing-')); directories.push(path)
    const db = createClient({ url: `file:${join(path, 'fixture.db')}` }); clients.push(db)
    await expect(createFxCameraWorkspaceStore(db, 1).read()).rejects.toThrow()
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE name='desktop_fx_board_camera'")
    expect(tables.rows).toHaveLength(0)
})

test('a short competing workspace write does not lose the next board view save', async () => {
    const path = await mkdtemp(join(tmpdir(), 'fx-camera-contention-')); directories.push(path)
    const url = `file:${join(path, 'fixture.db')}`
    const db = createClient({ url }), other = createClient({ url })
    clients.push(db, other)
    await db.executeMultiple(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; ${FX_BOARD_CAMERA_SCHEMA_SQL}`)
    const store = createFxCameraWorkspaceStore(db, 1), signal = new AbortController().signal
    await store.write({ workspaceId: 1, expectedRevision: 0, requestId, camera }, signal)
    const next = { workspaceId: 1, expectedRevision: 1, requestId: '00000000-0000-4000-8000-000000000002', camera: { ...camera, zoom: 1.4 } }
    const otherWrite = await other.transaction('write')
    const release = new Promise<void>(resolve => setTimeout(resolve, 80)).then(() => otherWrite.commit())
    try {
        const receipt = await store.write(next, signal)
        expect(receipt).toEqual({ status: 'saved', requestId: next.requestId, snapshot: { workspaceId: 1, revision: 2, camera: next.camera } })
        expect(await store.write(next, signal)).toEqual(receipt)
    } finally { await release; otherWrite.close() }
})

test('revoked ownership and cancellation do not write a board view', async () => {
    const path = await mkdtemp(join(tmpdir(), 'fx-camera-revoked-')); directories.push(path)
    const url = `file:${join(path, 'fixture.db')}`
    const db = createClient({ url }), other = createClient({ url })
    clients.push(db, other)
    await db.executeMultiple(FX_BOARD_CAMERA_SCHEMA_SQL)
    const store = createFxCameraWorkspaceStore(db, 1)
    const input = { workspaceId: 1, expectedRevision: 0, requestId, camera }
    const otherWrite = await other.transaction('write')
    const abort = new AbortController()
    try {
        const pending = store.write(input, abort.signal)
        abort.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally { await otherWrite.rollback(); otherWrite.close() }
    await expect(store.write(input, new AbortController().signal, async () => { throw Error('Workspace changed.') })).rejects.toThrow('Workspace changed.')
    expect(await store.read()).toEqual({ workspaceId: 1, revision: 0, camera: null })
})

test('overlapping camera saves cannot both win the same workspace revision', async () => {
    const path = await mkdtemp(join(tmpdir(), 'fx-camera-race-')); directories.push(path)
    const url = `file:${join(path, 'fixture.db')}`
    const first = createClient({ url }), second = createClient({ url })
    clients.push(first, second)
    await first.executeMultiple(`PRAGMA journal_mode=WAL; ${FX_BOARD_CAMERA_SCHEMA_SQL}`)
    const input = { workspaceId: 1, expectedRevision: 0, requestId, camera }, signal = new AbortController().signal
    const [a, b] = await Promise.all([
        createFxCameraWorkspaceStore(first, 1).write(input, signal),
        createFxCameraWorkspaceStore(second, 1).write({ ...input, requestId: '00000000-0000-4000-8000-000000000002', camera: { ...camera, zoom: 1.8 } }, signal),
    ])
    expect([a.status, b.status].sort()).toEqual(['conflict', 'saved'])
    expect(a.snapshot).toEqual(b.snapshot)
    expect(a.snapshot.revision).toBe(1)
})

test('a lost commit acknowledgement is reconciled only by an explicit same-request retry', async () => {
    const path = await mkdtemp(join(tmpdir(), 'fx-camera-ack-')); directories.push(path)
    const db = createClient({ url: `file:${join(path, 'fixture.db')}` }); clients.push(db)
    await db.executeMultiple(FX_BOARD_CAMERA_SCHEMA_SQL)
    const store = createFxCameraWorkspaceStore(db, 1)
    const input = { workspaceId: 1, expectedRevision: 0, requestId, camera }, signal = new AbortController().signal
    const open = db.transaction.bind(db)
    const transactions = vi.spyOn(db, 'transaction').mockImplementationOnce(async () => {
        const tx = await open('deferred')
        const commit = tx.commit.bind(tx)
        vi.spyOn(tx, 'commit').mockImplementationOnce(async () => {
            await commit()
            throw Object.assign(Error('Commit acknowledgement lost'), { code: 'SQLITE_BUSY' })
        })
        return tx
    })
    await expect(store.write(input, signal)).rejects.toThrow('Commit acknowledgement lost')
    expect(transactions).toHaveBeenCalledTimes(1)
    expect(await store.write(input, signal)).toEqual({ status: 'saved', requestId, snapshot: { workspaceId: 1, revision: 1, camera } })
})
