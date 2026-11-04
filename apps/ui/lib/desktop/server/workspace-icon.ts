import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { DESKTOP_IMAGE_MAX_BYTES, DESKTOP_IMAGE_MAX_PIXELS, DesktopImageBytesError, desktopRasterKind, inspectDesktopImageBytes } from './image-bytes'
import { DesktopHttpError } from './auth'
import { desktopWorkspaceIconById, type DesktopWorkspaceSavedIcon } from '../icon-catalog'

// The workspace icon slice keeps its own tables beside the central schema, so the central
// database/store files stay untouched: this module owns the initializer and runs it lazily on
// the same pooled client before the first read or write.
//
// The illustration picker stored one nullable catalog ID. The upload slice widens that row to an
// either/or selection — a catalog member or an uploaded raster's opaque identity — and adds a
// separate byte store, because a small raster belongs beside the selection it was validated for:
// one durable transaction commits both, replaced selections delete their bytes, and no file ever
// lands on disk under a path a request could name.
const CREATE_DESKTOP_WORKSPACE_ICON_BYTES = `
    CREATE TABLE IF NOT EXISTS desktop_workspace_icon_bytes (
        identity TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        bytes BLOB NOT NULL,
        created_at TEXT NOT NULL
    )
`

const CREATE_DESKTOP_WORKSPACE_ICON = `
    CREATE TABLE IF NOT EXISTS desktop_workspace_icon (
        workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
        catalog_id TEXT,
        upload_id TEXT REFERENCES desktop_workspace_icon_bytes(identity),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((catalog_id IS NOT NULL AND upload_id IS NULL) OR (catalog_id IS NULL AND upload_id IS NOT NULL))
    )
`

const ensured = new WeakMap<Client, Promise<void>>()

function ensureDesktopWorkspaceIconStore(db: Client): Promise<void> {
    let ready = ensured.get(db)
    if (!ready) {
        ready = migrateDesktopWorkspaceIconStore(db)
        ensured.set(db, ready)
        // A failed initializer must not poison later calls: the next one retries.
        void ready.catch(() => ensured.delete(db))
    }
    return ready
}

// Databases from the illustration-only slice carry catalog_id as NOT NULL; the widened row is
// rebuilt in one transaction and the committed selection is preserved. Fresh databases and
// already-migrated ones skip the rebuild.
async function migrateDesktopWorkspaceIconStore(db: Client): Promise<void> {
    const existing = await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name='desktop_workspace_icon'`)
    if (!existing.rows.length) {
        await db.execute(CREATE_DESKTOP_WORKSPACE_ICON_BYTES)
        await db.execute(CREATE_DESKTOP_WORKSPACE_ICON)
        return
    }
    const columns = (await db.execute(`PRAGMA table_info(desktop_workspace_icon)`)).rows.map(row => String(row.name))
    if (columns.includes('upload_id')) {
        await db.execute(CREATE_DESKTOP_WORKSPACE_ICON_BYTES)
        return
    }
    const transaction = await db.transaction('write')
    try {
        await transaction.execute(CREATE_DESKTOP_WORKSPACE_ICON_BYTES)
        await transaction.execute(`CREATE TABLE desktop_workspace_icon_migrated (
            workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
            catalog_id TEXT,
            upload_id TEXT REFERENCES desktop_workspace_icon_bytes(identity),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((catalog_id IS NOT NULL AND upload_id IS NULL) OR (catalog_id IS NULL AND upload_id IS NOT NULL))
        )`)
        await transaction.execute(`INSERT INTO desktop_workspace_icon_migrated (workspace_id,catalog_id,upload_id,created_at,updated_at)
            SELECT workspace_id,catalog_id,NULL,created_at,updated_at FROM desktop_workspace_icon`)
        // The illustration-only schema never committed rasters, so any byte rows are orphans.
        await transaction.execute('DELETE FROM desktop_workspace_icon_bytes')
        await transaction.execute('DROP TABLE desktop_workspace_icon')
        await transaction.execute('ALTER TABLE desktop_workspace_icon_migrated RENAME TO desktop_workspace_icon')
        await transaction.commit()
    } finally { transaction.close() }
}

// The catalog slice's read, kept for its existing callers: the validated illustration ID, or
// null when the workspace has no icon, an unreadable one or an uploaded raster instead.
export async function readDesktopWorkspaceIcon(db: Client): Promise<string | null> {
    return (await readDesktopWorkspaceIconSelection(db)).iconCatalogId
}

// The saved-icon descriptor: which kind the workspace carries and the token each kind renders
// from. Both values fail closed on a stored value outside the allowlist.
export async function readDesktopWorkspaceIconSelection(db: Client): Promise<DesktopWorkspaceSavedIcon> {
    await ensureDesktopWorkspaceIconStore(db)
    const result = await db.execute(`SELECT i.catalog_id,i.upload_id FROM desktop_workspace_icon i WHERE i.workspace_id=1`)
    const row = result.rows[0]
    if (!row) return { iconCatalogId: null, iconUploadId: null }
    const catalogId = typeof row.catalog_id === 'string' && desktopWorkspaceIconById(row.catalog_id) ? row.catalog_id : null
    const uploadId = typeof row.upload_id === 'string' && catalogId === null ? row.upload_id : null
    return { iconCatalogId: catalogId, iconUploadId: uploadId }
}

export const desktopWorkspaceIconUpdateSchema = z.object({
    name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX),
    catalogId: z.string().min(1).max(200).nullable().optional(),
}).strict()
export type DesktopWorkspaceIconUpdate = z.infer<typeof desktopWorkspaceIconUpdateSchema>

// Name and illustration are one original workspace-settings save. Omission preserves the icon;
// an explicit null resets to the default. Validation precedes every persistent mutation.
export async function writeDesktopWorkspaceIcon(db: Client, input: DesktopWorkspaceIconUpdate): Promise<DesktopWorkspaceIconUpdateResult> {
    const parsed = desktopWorkspaceIconUpdateSchema.safeParse(input)
    if (!parsed.success) throw new DesktopHttpError(400, `Enter a workspace name between 1 and ${WORKSPACE_NAME_MAX} characters and choose a built-in illustration.`)
    const { name, catalogId } = parsed.data
    if (catalogId !== undefined && catalogId !== null && !desktopWorkspaceIconById(catalogId)) throw new DesktopHttpError(400, 'Unknown icon')
    await ensureDesktopWorkspaceIconStore(db)
    const transaction = await db.transaction('write')
    try {
        const now = new Date().toISOString()
        const updated = await transaction.execute({ sql: 'UPDATE desktop_workspace SET name=?,updated_at=? WHERE id=1', args: [name, now] })
        if (updated.rowsAffected !== 1) throw new DesktopHttpError(404, 'Workspace not found')
        if (catalogId === null) {
            await transaction.execute('DELETE FROM desktop_workspace_icon WHERE workspace_id=1')
        } else if (catalogId !== undefined) await transaction.execute({
            sql: 'INSERT INTO desktop_workspace_icon (workspace_id,catalog_id,upload_id,created_at,updated_at) VALUES (1,?,NULL,?,?) ON CONFLICT(workspace_id) DO UPDATE SET catalog_id=excluded.catalog_id,upload_id=NULL,updated_at=excluded.updated_at',
            args: [catalogId, now, now],
        })
        if (catalogId !== undefined) await transaction.execute('DELETE FROM desktop_workspace_icon_bytes WHERE identity NOT IN (SELECT upload_id FROM desktop_workspace_icon WHERE upload_id IS NOT NULL)')
        const result = await committedDesktopWorkspaceIcon(transaction)
        await transaction.commit()
        return result
    } finally { transaction.close() }
}

export type DesktopWorkspaceIconUpdateResult = { name: string; catalogId: string | null; uploadId: string | null }

const DESKTOP_LOGO_KINDS: readonly string[] = ['png', 'jpeg', 'webp']

// Accepts only a static PNG, JPEG or WebP within the original logo limit, then normalizes it to
// one small WebP raster and commits the bytes together with the selection in one transaction.
// A failed commit rolls the bytes back, so a replaced or cancelled upload never leaks and the
// previous icon survives.
export async function writeDesktopWorkspaceLogoUpload(db: Client, input: { name: string; logo: File }): Promise<DesktopWorkspaceIconUpdateResult> {
    const name = input.name.trim()
    if (!name || name.length > WORKSPACE_NAME_MAX) throw new DesktopHttpError(400, `Enter a workspace name between 1 and ${WORKSPACE_NAME_MAX} characters.`)
    if (input.logo.size > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Image is too large (max 8MB).')
    const kind = desktopRasterKind(input.logo.name)
    if (!kind || !DESKTOP_LOGO_KINDS.includes(kind)) throw new DesktopHttpError(415, 'Please choose a PNG, JPEG or WebP image.')
    const bytes = new Uint8Array(await input.logo.arrayBuffer())
    try { inspectDesktopImageBytes(kind, bytes) } catch (error) {
        if (error instanceof DesktopImageBytesError) {
            if (error.reason === 'dimensions') throw new DesktopHttpError(413, 'This image is too large to use as the workspace icon.')
            if (error.reason === 'mismatch') throw new DesktopHttpError(415, 'This file is not a supported image.')
            if (error.reason === 'animation') throw new DesktopHttpError(415, 'Animated images can’t be the workspace icon. Choose a static image.')
        }
        throw new DesktopHttpError(415, 'This image is damaged and can’t be used.')
    }
    // Decode before taking SQLite's write lock; a bad image never begins a name/icon write.
    const raster = await normalizeDesktopLogoRaster(bytes)
    await ensureDesktopWorkspaceIconStore(db)
    const transaction = await db.transaction('write')
    try {
        const now = new Date().toISOString()
        const updated = await transaction.execute({ sql: 'UPDATE desktop_workspace SET name=?,updated_at=? WHERE id=1', args: [name, now] })
        if (updated.rowsAffected !== 1) throw new DesktopHttpError(404, 'Workspace not found')
        const identity = crypto.randomUUID()
        await transaction.execute({
            sql: 'INSERT INTO desktop_workspace_icon_bytes (identity,content_type,bytes,created_at) VALUES (?,?,?,?)',
            args: [identity, 'image/webp', raster, now],
        })
        await transaction.execute({
            sql: 'INSERT INTO desktop_workspace_icon (workspace_id,catalog_id,upload_id,created_at,updated_at) VALUES (1,NULL,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET catalog_id=NULL,upload_id=excluded.upload_id,updated_at=excluded.updated_at',
            args: [identity, now, now],
        })
        await transaction.execute('DELETE FROM desktop_workspace_icon_bytes WHERE identity NOT IN (SELECT upload_id FROM desktop_workspace_icon WHERE upload_id IS NOT NULL)')
        const result = await committedDesktopWorkspaceIcon(transaction)
        await transaction.commit()
        return result
    } finally { transaction.close() }
}

// The original stores one raster capped at 256px: normalize the orientation, cap the dimensions
// and encode one WebP at the original's quality.
async function normalizeDesktopLogoRaster(bytes: Uint8Array): Promise<Uint8Array> {
    const { default: sharp } = await import('sharp')
    try {
        const webp = await sharp(Buffer.from(bytes), { limitInputPixels: DESKTOP_IMAGE_MAX_PIXELS })
            .rotate()
            .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82, effort: 6 })
            .toBuffer()
        return new Uint8Array(webp)
    } catch {
        throw new DesktopHttpError(415, 'This image is damaged and can’t be used.')
    }
}

export type DesktopWorkspaceIconBytes = { contentType: string; bytes: Uint8Array }

// The committed raster for its opaque identity; a replaced selection's bytes no longer exist, so
// an unknown identity fails closed.
export async function readDesktopWorkspaceIconBytes(db: Client, identity: string): Promise<DesktopWorkspaceIconBytes | null> {
    await ensureDesktopWorkspaceIconStore(db)
    const result = await db.execute({
        sql: `SELECT b.content_type,b.bytes FROM desktop_workspace_icon_bytes b
            JOIN desktop_workspace_icon i ON i.upload_id=b.identity WHERE i.workspace_id=1 AND b.identity=?`,
        args: [identity],
    })
    const row = result.rows[0]
    if (!row || typeof row.content_type !== 'string') return null
    const stored = row.bytes
    if (!(stored instanceof Uint8Array) && !(stored instanceof ArrayBuffer)) return null
    return { contentType: row.content_type, bytes: stored instanceof Uint8Array ? stored : new Uint8Array(stored) }
}

type IconTransaction = Awaited<ReturnType<Client['transaction']>>

async function committedDesktopWorkspaceIcon(transaction: IconTransaction): Promise<DesktopWorkspaceIconUpdateResult> {
    const saved = (await transaction.execute(`SELECT w.name,i.catalog_id,i.upload_id FROM desktop_workspace w
        LEFT JOIN desktop_workspace_icon i ON i.workspace_id=w.id WHERE w.id=1`)).rows[0]
    const storedCatalog = saved.catalog_id
    const storedUpload = saved.upload_id
    const catalogId = typeof storedCatalog === 'string' && desktopWorkspaceIconById(storedCatalog) ? storedCatalog : null
    const uploadId = typeof storedUpload === 'string' && catalogId === null ? storedUpload : null
    return { name: String(saved.name), catalogId, uploadId }
}
