import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_WORKSPACE_ICONS } from '@/lib/desktop/icon-catalog'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { DESKTOP_IMAGE_MAX_BYTES, inspectDesktopImageBytes } from '@/lib/desktop/server/image-bytes'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopWorkspaceIcon, readDesktopWorkspaceIconSelection } from '@/lib/desktop/server/workspace-icon'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET, PUT } from './route'
import { GET as readIconBytes } from './bytes/route'

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
function multipartRequest(form: FormData) {
    return new Request(`${runtime.app.origin}/api/desktop/workspace/icon`, {
        method: 'PUT', headers: { host: new URL(runtime.app.origin).host,
            origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}` },
        body: form,
    })
}
function bytesRequest(identity: string | null) {
    const url = new URL(`${runtime.app.origin}/api/desktop/workspace/icon/bytes`)
    if (identity !== null) url.searchParams.set('identity', identity)
    return new Request(url, { headers: { host: new URL(runtime.app.origin).host,
        origin: runtime.app.origin, cookie: `rerun-desktop-session=${runtime.app.sessionToken}` } })
}
const put = (body: unknown) => PUT(request(body))
const name = async () => String((await (await openDesktopDatabase(root)).execute('SELECT name FROM desktop_workspace WHERE id=1')).rows[0]?.name)
const iconRows = async () => (await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_workspace_icon')).rows
const byteRows = async () => (await (await openDesktopDatabase(root)).execute('SELECT identity,content_type FROM desktop_workspace_icon_bytes')).rows

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

async function logoForm(name = '  Acme Studio  '): Promise<FormData> {
    const { default: sharp } = await import('sharp')
    const png = new Uint8Array(await sharp({ create: { width: 40, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer())
    const form = new FormData()
    form.set('name', name)
    form.set('logoFile', new File([png], 'logo.png', { type: 'image/png' }))
    return form
}

async function committedLogo(): Promise<{ name: string; catalogId: string | null; uploadId: string | null }> {
    const form = await logoForm()
    const saved = await PUT(multipartRequest(form))
    expect(saved.status).toBe(200)
    return await saved.json()
}

test('a multipart upload normalizes one static PNG and commits name, bytes and selection in one transaction', async () => {
    const saved = await committedLogo()
    expect(saved.name).toBe('Acme Studio')
    expect(saved.catalogId).toBeNull()
    expect(saved.uploadId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(await name()).toBe('Acme Studio')
    const rows = await iconRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.catalog_id).toBeNull()
    expect(rows[0]!.upload_id).toBe(saved.uploadId)
    const bytes = await byteRows()
    expect(bytes).toEqual([{ identity: saved.uploadId, content_type: 'image/webp' }])
    // The committed payload is one bounded raster, not the original file's bytes.
    const { default: sharp } = await import('sharp')
    const stored = (await (await openDesktopDatabase(root)).execute(`SELECT bytes FROM desktop_workspace_icon_bytes WHERE identity='${saved.uploadId}'`)).rows[0]!.bytes
    const raster = Buffer.from(stored instanceof Uint8Array ? stored : new Uint8Array(stored as ArrayBuffer))
    const meta = await sharp(raster).metadata()
    expect(meta.format).toBe('webp')
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(256)
    expect(await (await GET(request())).json()).toEqual({ catalogId: null, uploadId: saved.uploadId })
})

test('the committed raster is served by identity, fails closed otherwise and refuses cross-site reads', async () => {
    const saved = await committedLogo()
    const served = await readIconBytes(bytesRequest(saved.uploadId))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/webp')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('content-security-policy')).toContain('sandbox')
    expect(served.headers.get('cache-control')).toBe('private, no-store')
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(0)
    expect((await readIconBytes(bytesRequest(null))).status).toBe(404)
    expect((await readIconBytes(bytesRequest('not-a-uuid'))).status).toBe(404)
    expect((await readIconBytes(bytesRequest('00000000-0000-0000-0000-000000000000'))).status).toBe(404)
    const cross = bytesRequest(saved.uploadId); cross.headers.set('sec-fetch-site', 'cross-site')
    expect((await readIconBytes(cross)).status).toBe(403)
    const anonymous = bytesRequest(saved.uploadId); anonymous.headers.delete('cookie')
    expect((await readIconBytes(anonymous)).status).toBe(401)
})

test('replacing an upload deletes the previous raster, and a catalog selection or reset clears the byte store', async () => {
    const originalUpload = await committedLogo()
    const replacement = await committedLogo()
    expect(await byteRows()).toEqual([{ identity: replacement.uploadId, content_type: 'image/webp' }])
    expect((await readIconBytes(bytesRequest(originalUpload.uploadId))).status).toBe(404)
    expect((await put({ name: 'Illustrated', catalogId: second })).status).toBe(200)
    expect(await byteRows()).toEqual([])
    expect((await iconRows())[0]!.catalog_id).toBe(second)
    expect((await readIconBytes(bytesRequest(replacement.uploadId))).status).toBe(404)
    const resetUpload = await committedLogo()
    expect((await put({ name: 'Back to default', catalogId: null })).status).toBe(200)
    expect(await iconRows()).toEqual([])
    expect(await byteRows()).toEqual([])
    expect((await readIconBytes(bytesRequest(resetUpload.uploadId))).status).toBe(404)
})

test('an oversized, unsupported or damaged upload is rejected before mutating name, icon or byte store', async () => {
    await put({ name: 'Keep me', catalogId: first })
    const { default: sharp } = await import('sharp')
    const png = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer())
    const oversized = new FormData()
    oversized.set('name', 'Oversized')
    oversized.set('logoFile', new File([new Uint8Array(DESKTOP_IMAGE_MAX_BYTES + 1)], 'logo.png', { type: 'image/png' }))
    expect((await PUT(multipartRequest(oversized))).status).toBe(413)
    const animatedKind = new FormData()
    animatedKind.set('name', 'Animated')
    animatedKind.set('logoFile', new File([png], 'logo.gif', { type: 'image/gif' }))
    expect((await PUT(multipartRequest(animatedKind))).status).toBe(415)
    const damaged = new FormData()
    damaged.set('name', 'Damaged')
    damaged.set('logoFile', new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'logo.png', { type: 'image/png' }))
    expect((await PUT(multipartRequest(damaged))).status).toBe(415)
    const missing = new FormData()
    missing.set('name', 'Missing file')
    expect((await PUT(multipartRequest(missing))).status).toBe(400)
    expect(await name()).toBe('Keep me')
    expect(await iconRows()).toHaveLength(1)
    expect((await iconRows())[0]!.catalog_id).toBe(first)
    expect(await byteRows()).toEqual([])
})

test('a committed upload survives a full database reopen and the illustration-only schema migrates in place', async () => {
    const saved = await committedLogo()
    await closeDesktopDatabase(root)
    const reopened = await (await GET(request())).json()
    expect(reopened).toEqual({ catalogId: null, uploadId: saved.uploadId })
    await closeDesktopDatabase(root)

    const db = await openDesktopDatabase(root)
    await db.execute('DROP TABLE desktop_workspace_icon')
    await db.execute(`CREATE TABLE desktop_workspace_icon (
        workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
        catalog_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL )`)
    await db.execute({ sql: 'INSERT INTO desktop_workspace_icon (workspace_id,catalog_id,created_at,updated_at) VALUES (1,?,?,?)', args: [first, '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'] })
    await closeDesktopDatabase(root)
    expect(await (await GET(request())).json()).toEqual({ catalogId: first })
    const columns = (await (await openDesktopDatabase(root)).execute(`PRAGMA table_info(desktop_workspace_icon)`)).rows.map(row => String(row.name))
    for (const column of ['workspace_id', 'catalog_id', 'upload_id', 'created_at', 'updated_at']) expect(columns).toContain(column)
    expect(await iconRows()).toHaveLength(1)
    expect((await iconRows())[0]!.catalog_id).toBe(first)
    const migrated = await openDesktopDatabase(root)
    await expect(migrated.execute(`INSERT INTO desktop_workspace_icon (workspace_id,catalog_id,upload_id,created_at,updated_at) VALUES (1,'${first}','${first}','x','y')`)).rejects.toThrow()
    await closeDesktopDatabase(root)
})

test('the illustration-only store read keeps its catalog-only contract after an upload replaces it', async () => {
    const saved = await committedLogo()
    expect(await readDesktopWorkspaceIcon(await openDesktopDatabase(root))).toBeNull()
    await put({ name: 'Illustrated', catalogId: second })
    expect(await readDesktopWorkspaceIconSelection(await openDesktopDatabase(root))).toEqual({ iconCatalogId: second, iconUploadId: null })
})

test('name-only save preserves the uploaded bytes and identity across reopen', async () => {
    const saved = await committedLogo()
    const before = await iconRows(), bytesBefore = await byteRows()
    const response = await put({ name: 'Renamed upload' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'Renamed upload', catalogId: null, uploadId: saved.uploadId })
    expect(await iconRows()).toEqual(before)
    expect(await byteRows()).toEqual(bytesBefore)
    await closeDesktopDatabase(root)
    expect(await name()).toBe('Renamed upload')
    expect(await (await GET(request())).json()).toEqual({ catalogId: null, uploadId: saved.uploadId })
    expect((await readIconBytes(bytesRequest(saved.uploadId))).status).toBe(200)
})

test.each(['upload', 'catalog', 'reset'] as const)('failed byte cleanup rolls back name, selection and bytes for %s replacement', async replacement => {
    const saved = await committedLogo()
    const before = await iconRows(), bytesBefore = await byteRows(), db = await openDesktopDatabase(root)
    await db.execute("CREATE TRIGGER reject_logo_cleanup BEFORE DELETE ON desktop_workspace_icon_bytes BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END")
    const replace = async () => replacement === 'upload'
        ? PUT(multipartRequest(await logoForm('Replacement')))
        : put({ name: 'Replacement', catalogId: replacement === 'catalog' ? second : null })
    expect((await replace()).status).toBe(500)
    expect(await name()).toBe(saved.name)
    expect(await iconRows()).toEqual(before)
    expect(await byteRows()).toEqual(bytesBefore)
    expect((await readIconBytes(bytesRequest(saved.uploadId))).status).toBe(200)
    await db.execute('DROP TRIGGER reject_logo_cleanup')
    expect((await replace()).status).toBe(200)
    expect(await name()).toBe('Replacement')
    expect((await readIconBytes(bytesRequest(saved.uploadId))).status).toBe(404)
})

test('multipart saves reject unexpected keys, duplicate claims and non-text names without changing the saved logo', async () => {
    const saved = await committedLogo()
    const before = await iconRows(), bytesBefore = await byteRows()
    for (const variant of ['extra', 'catalog', 'duplicate-name', 'duplicate-logo', 'file-name', 'missing-name', 'text-logo']) {
        const form = await logoForm('Must not save')
        if (variant === 'extra') form.set('workspaceId', '2')
        if (variant === 'catalog') form.set('catalogId', second)
        if (variant === 'duplicate-name') form.append('name', 'Other name')
        if (variant === 'duplicate-logo') form.append('logoFile', form.get('logoFile') as File)
        if (variant === 'file-name') form.set('name', new File(['Not a name'], 'name.txt'))
        if (variant === 'missing-name') form.delete('name')
        if (variant === 'text-logo') form.set('logoFile', 'not an uploaded file')
        expect((await PUT(multipartRequest(form))).status, variant).toBe(400)
    }
    expect(await name()).toBe(saved.name)
    expect(await iconRows()).toEqual(before)
    expect(await byteRows()).toEqual(bytesBefore)
})

test.each([undefined, '1', String(DESKTOP_IMAGE_MAX_BYTES + 64 * 1024 + 1)])('caps the actual upload stream and cancels it with Content-Length %s', async declaredLength => {
    await put({ name: 'Keep me', catalogId: first })
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)) },
        cancel,
    })
    const headers = request().headers
    headers.set('content-type', 'multipart/form-data; boundary=oversized-fixture')
    if (declaredLength !== undefined) headers.set('content-length', declaredLength)
    const upload = new Request(`${runtime.app.origin}/api/desktop/workspace/icon`, {
        method: 'PUT', headers, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect((await PUT(upload)).status).toBe(413)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await name()).toBe('Keep me')
    expect(await (await GET(request())).json()).toEqual({ catalogId: first })
    expect(await byteRows()).toEqual([])
})

test('malformed bodies and unknown JSON fields are refused without replacing an upload', async () => {
    const saved = await committedLogo()
    const before = await iconRows(), bytesBefore = await byteRows()
    expect((await put({ name: 'Wrong workspace', workspaceId: 2 })).status).toBe(400)
    expect((await put({ name: 'Wrong identity', uploadId: saved.uploadId })).status).toBe(400)
    expect((await put({ name: 'x'.repeat(4097) })).status).toBe(413)
    const headers = request().headers
    headers.set('content-type', 'multipart/form-data; boundary=missing-parts')
    expect((await PUT(new Request(`${runtime.app.origin}/api/desktop/workspace/icon`, { method: 'PUT', headers, body: 'broken form' }))).status).toBe(400)
    const wrongType = request({ name: 'Wrong type' }); wrongType.headers.set('content-type', 'text/plain')
    expect((await PUT(wrongType)).status).toBe(415)
    expect(await name()).toBe(saved.name)
    expect(await iconRows()).toEqual(before)
    expect(await byteRows()).toEqual(bytesBefore)
})

// Valid PNG chunk framing/CRCs with an invalid compressed image payload: structural admission
// succeeds, so this exercises the real decoder error rather than the earlier signature check.
function undecodablePng(): Uint8Array<ArrayBuffer> {
    const chunk = (type: string, payload: Buffer) => {
        const content = Buffer.concat([Buffer.from(type, 'ascii'), payload])
        let crc = 0xffffffff
        for (const byte of content) {
            crc ^= byte
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
        }
        const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
        length.writeUInt32BE(payload.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
        return Buffer.concat([length, content, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), chunk('IDAT', Buffer.from('invalid deflate payload')), chunk('IEND', Buffer.alloc(0))]))
}

test('decoder failures return 415 before a write transaction and preserve the previous name and upload', async () => {
    const saved = await committedLogo()
    const before = await iconRows(), bytesBefore = await byteRows(), db = await openDesktopDatabase(root)
    const transactions = vi.spyOn(db, 'transaction')
    const bytes = undecodablePng()
    expect(inspectDesktopImageBytes('png', bytes)).toEqual({ width: 1, height: 1, contentType: 'image/png' })
    const form = new FormData()
    form.set('name', 'Must not save')
    form.set('logoFile', new File([bytes], 'undecodable.png', { type: 'image/png' }))
    const response = await PUT(multipartRequest(form))
    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: 'This image is damaged and can’t be used.' })
    expect(transactions).not.toHaveBeenCalled()
    expect(await name()).toBe(saved.name)
    expect(await iconRows()).toEqual(before)
    expect(await byteRows()).toEqual(bytesBefore)
})

test('unselected orphan bytes cannot be served as the workspace logo', async () => {
    await committedLogo()
    const db = await openDesktopDatabase(root), identity = crypto.randomUUID()
    await db.execute({ sql: 'INSERT INTO desktop_workspace_icon_bytes(identity,content_type,bytes,created_at) VALUES (?,?,?,?)',
        args: [identity, 'image/webp', new Uint8Array([1, 2, 3]), new Date().toISOString()] })
    expect((await readIconBytes(bytesRequest(identity))).status).toBe(404)
})
