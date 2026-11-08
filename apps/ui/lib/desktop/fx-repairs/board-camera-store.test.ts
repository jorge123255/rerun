import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
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
