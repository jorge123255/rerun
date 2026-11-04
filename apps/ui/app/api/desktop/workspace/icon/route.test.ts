import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_WORKSPACE_ICONS } from '@/lib/desktop/icon-catalog'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopWorkspaceIcon } from '@/lib/desktop/server/workspace-icon'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET, PUT } from './route'

const originalEnv = { ...process.env }
const first = DESKTOP_WORKSPACE_ICONS[0].id, second = DESKTOP_WORKSPACE_ICONS[1].id
let root: string, runtime: DesktopRuntime
function request(body?: unknown) {
    return new Request(`${runtime.app.origin}/api/desktop/workspace/icon`, {
        method: body === undefined ? 'GET' : 'PUT', headers: { host: new URL(runtime.app.origin).host,
            origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
}
const put = (body: unknown) => PUT(request(body))
const name = async () => String((await (await openDesktopDatabase(root)).execute('SELECT name FROM desktop_workspace WHERE id=1')).rows[0]?.name)
const iconRows = async () => (await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_workspace_icon')).rows

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-workspace-icon-'))
    runtime = { protocolVersion: 1, launchNonce: 'icon-launch', buildId: 'icon-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3198', sessionToken: 'i'.repeat(48) }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused-local-fixture' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    await openDesktopDatabase(root)
})
afterEach(async () => {
    vi.restoreAllMocks()
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('reads the default and atomically returns the trimmed name and durable catalog selection', async () => {
    const empty = await GET(request())
    expect(empty.status).toBe(200)
    expect(empty.headers.get('cache-control')).toBe('no-store')
    expect(await empty.json()).toEqual({ catalogId: null })
    const saved = await put({ name: '  Acme Studio  ', catalogId: first })
    expect(saved.status).toBe(200)
    expect(saved.headers.get('cache-control')).toBe('no-store')
    expect(await saved.json()).toEqual({ name: 'Acme Studio', catalogId: first })
    expect(await name()).toBe('Acme Studio')
    expect(await (await GET(request())).json()).toEqual({ catalogId: first })
})

test('name-only save leaves the exact icon row untouched and persists both fields across restart', async () => {
    await put({ name: 'Original name', catalogId: first })
    const before = await iconRows()
    const saved = await put({ name: 'New name' })
    expect(await saved.json()).toEqual({ name: 'New name', catalogId: first })
    expect(await iconRows()).toEqual(before)
    await closeDesktopDatabase(root)
    expect(await name()).toBe('New name')
    expect(await (await GET(request())).json()).toEqual({ catalogId: first })
})

test('explicit null resets the selection while preserving the committed name after restart', async () => {
    await put({ name: 'Original', catalogId: first })
    const saved = await put({ name: 'Default illustration', catalogId: null })
    expect(await saved.json()).toEqual({ name: 'Default illustration', catalogId: null })
    expect(await iconRows()).toEqual([])
    await closeDesktopDatabase(root)
    expect(await name()).toBe('Default illustration')
    expect(await (await GET(request())).json()).toEqual({ catalogId: null })
})

test('invalid IDs and invalid names cannot partially rename the workspace or replace its icon', async () => {
    await put({ name: 'Keep me', catalogId: first })
    for (const catalogId of ['https://example.invalid/icon.webp', '../outside.webp', '/workspace-icons/' + first, 'unknown.webp', '', 7]) {
        expect((await put({ name: 'Must not save', catalogId })).status).toBe(400)
    }
    for (const body of [{ name: '   ', catalogId: second }, { name: 'x'.repeat(WORKSPACE_NAME_MAX + 1), catalogId: second },
        { catalogId: second }, { name: 'Changed', catalogId: second, workspaceId: 2 }]) {
        expect((await put(body)).status).toBe(400)
    }
    expect(await name()).toBe('Keep me')
    expect(await (await GET(request())).json()).toEqual({ catalogId: first })
    expect((await put({ name: 'x'.repeat(WORKSPACE_NAME_MAX) })).status).toBe(200)
})

test.each(['insert', 'update', 'delete'] as const)('rolls back the name when the icon %s fails, and a retry commits both', async operation => {
    if (operation === 'insert') await GET(request())
    else await put({ name: 'My workspace', catalogId: first })
    const before = await iconRows(), db = await openDesktopDatabase(root)
    await db.execute(`CREATE TRIGGER reject_icon BEFORE ${operation.toUpperCase()} ON desktop_workspace_icon BEGIN SELECT RAISE(ABORT, 'fixture icon failure'); END`)
    const body = { name: 'Atomic new name', catalogId: operation === 'delete' ? null : second }
    expect((await put(body)).status).toBe(500)
    expect(await name()).toBe('My workspace')
    expect(await iconRows()).toEqual(before)
    await db.execute('DROP TRIGGER reject_icon')
    expect(await (await put(body)).json()).toEqual(body)
    await closeDesktopDatabase(root)
    expect(await name()).toBe('Atomic new name')
    expect(await (await GET(request())).json()).toEqual({ catalogId: body.catalogId })
})

test('corrupt legacy catalog values fail closed on GET, bootstrap store reads and name-only responses', async () => {
    await put({ name: 'Safe name', catalogId: first })
    const db = await openDesktopDatabase(root)
    await db.execute({ sql: 'UPDATE desktop_workspace_icon SET catalog_id=? WHERE workspace_id=1', args: ['https://untrusted.invalid/track'] })
    expect(await (await GET(request())).json()).toEqual({ catalogId: null })
    expect(await readDesktopWorkspaceIcon(db)).toBeNull()
    expect(await (await put({ name: 'Still safe' })).json()).toEqual({ name: 'Still safe', catalogId: null })
    expect(await (await put({ name: 'Repaired', catalogId: second })).json()).toEqual({ name: 'Repaired', catalogId: second })
})

test('enforces desktop session, host and same-origin mutation checks before any save', async () => {
    const anonymous = request({ name: 'No', catalogId: first }); anonymous.headers.delete('cookie')
    expect((await PUT(anonymous)).status).toBe(401)
    const foreign = request({ name: 'No', catalogId: first }); foreign.headers.set('origin', 'https://other.invalid')
    expect((await PUT(foreign)).status).toBe(403)
    const wrongHost = request(); wrongHost.headers.set('host', 'example.invalid')
    expect((await GET(wrongHost)).status).toBe(403)
    const crossSite = request(); crossSite.headers.set('sec-fetch-site', 'cross-site')
    expect((await GET(crossSite)).status).toBe(403)
    expect(await name()).toBe('My workspace')
    expect(await (await GET(request())).json()).toEqual({ catalogId: null })
})

test('requires the existing local workspace and enforces the icon foreign key', async () => {
    await GET(request())
    const db = await openDesktopDatabase(root)
    await expect(db.execute({ sql: 'INSERT INTO desktop_workspace_icon(workspace_id,catalog_id,created_at,updated_at) VALUES (2,?,?,?)', args: [first, 'fixture', 'fixture'] })).rejects.toThrow()
    await db.execute('DELETE FROM desktop_workspace WHERE id=1')
    expect((await put({ name: 'Must not recreate', catalogId: first })).status).toBe(404)
    expect(await iconRows()).toEqual([])
})

test('a failed lazy initializer is retried rather than poisoning the pooled client', async () => {
    const db = await openDesktopDatabase(root)
    vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('fixture initialization failure'))
    expect((await GET(request())).status).toBe(500)
    const retry = await GET(request())
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ catalogId: null })
})
