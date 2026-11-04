import 'server-only'
import type { Client } from '@libsql/client'
import { desktopWorkspaceIconById } from '../icon-catalog'
import { DesktopHttpError } from './auth'

// The workspace icon slice keeps its own table beside the central schema, so the central
// database/store files stay untouched: this module owns the initializer and runs it lazily on
// the same pooled client before the first read or write.
const CREATE_DESKTOP_WORKSPACE_ICON = `
    CREATE TABLE IF NOT EXISTS desktop_workspace_icon (
        workspace_id INTEGER PRIMARY KEY REFERENCES desktop_workspace(id),
        catalog_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
`

const ensured = new WeakMap<Client, Promise<void>>()

function ensureDesktopWorkspaceIconStore(db: Client): Promise<void> {
    let ready = ensured.get(db)
    if (!ready) {
        ready = db.execute(CREATE_DESKTOP_WORKSPACE_ICON)
        ensured.set(db, ready)
        // A failed initializer must not poison later calls: the next one retries.
        void ready.catch(() => ensured.delete(db))
    }
    return ready
}

export async function readDesktopWorkspaceIcon(db: Client): Promise<string | null> {
    await ensureDesktopWorkspaceIconStore(db)
    const result = await db.execute('SELECT catalog_id FROM desktop_workspace_icon WHERE workspace_id = 1')
    return result.rows.length ? String(result.rows[0]!.catalog_id) : null
}

// Only a catalog member persists: the caller supplies the illustration's own file name and the
// lookup decides, never an arbitrary URL or path.
export async function writeDesktopWorkspaceIcon(db: Client, catalogId: string): Promise<void> {
    if (!desktopWorkspaceIconById(catalogId)) throw new DesktopHttpError(400, 'Unknown icon')
    await ensureDesktopWorkspaceIconStore(db)
    const now = new Date().toISOString()
    await db.execute({
        sql: 'INSERT INTO desktop_workspace_icon (workspace_id, catalog_id, created_at, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET catalog_id = excluded.catalog_id, updated_at = excluded.updated_at',
        args: [catalogId, now, now],
    })
}
