import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { desktopWorkspaceIconById } from '@/lib/desktop/icon-catalog'

type Database = Pick<Client, 'execute'>
const table = `CREATE TABLE IF NOT EXISTS desktop_workspace_metadata_outbox (
 id INTEGER PRIMARY KEY CHECK(id=1), request_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 icon_catalog_id TEXT, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN(0,1)))`
/** Called inside the same transaction as name/logo. The catalog is only a derived menu cache. */
export async function saveDesktopWorkspaceMetadataOutbox(db: Database, name: string, iconCatalogId: string | null) {
    await db.execute(table)
    const prior = (await db.execute('SELECT request_id,name,icon_catalog_id FROM desktop_workspace_metadata_outbox WHERE id=1')).rows[0]
    if (prior && prior.name === name && prior.icon_catalog_id === iconCatalogId) return
    await db.execute({ sql: `INSERT INTO desktop_workspace_metadata_outbox(id,request_id,name,icon_catalog_id,acknowledged) VALUES(1,?,?,?,0)
        ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,name=excluded.name,icon_catalog_id=excluded.icon_catalog_id,acknowledged=0`, args: [randomUUID(), name, iconCatalogId] })
}
/** Explicit native migration: seed one cache-sync intent using existing committed metadata. */
export async function seedDesktopWorkspaceMetadataOutbox(db: Database, name: string, iconCatalogId: string | null) {
    await db.execute(table)
    await db.execute({ sql: 'INSERT OR IGNORE INTO desktop_workspace_metadata_outbox(id,request_id,name,icon_catalog_id,acknowledged) VALUES(1,?,?,?,0)', args: [randomUUID(), name, iconCatalogId] })
}
export async function readDesktopWorkspaceMetadataOutbox(db: Database) {
    await db.execute(table)
    const row = (await db.execute('SELECT request_id,name,icon_catalog_id FROM desktop_workspace_metadata_outbox WHERE id=1 AND acknowledged=0')).rows[0]
    if (!row) return null
    const iconCatalogId = row.icon_catalog_id === null ? null : String(row.icon_catalog_id)
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 60 || iconCatalogId && !desktopWorkspaceIconById(iconCatalogId)) throw new Error('Saved workspace metadata could not be read.')
    return { requestId: String(row.request_id), name: row.name, iconCatalogId }
}
export async function acknowledgeDesktopWorkspaceMetadataOutbox(db: Database, requestId: string) {
    await db.execute({ sql: 'UPDATE desktop_workspace_metadata_outbox SET acknowledged=1 WHERE id=1 AND request_id=?', args: [requestId] })
}
