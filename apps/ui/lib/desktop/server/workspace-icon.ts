import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
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
        ready = db.execute(CREATE_DESKTOP_WORKSPACE_ICON).then(() => {})
        ensured.set(db, ready)
        // A failed initializer must not poison later calls: the next one retries.
        void ready.catch(() => ensured.delete(db))
    }
    return ready
}

export async function readDesktopWorkspaceIcon(db: Client): Promise<string | null> {
    await ensureDesktopWorkspaceIconStore(db)
    const result = await db.execute('SELECT catalog_id FROM desktop_workspace_icon WHERE workspace_id = 1')
    const id = result.rows[0]?.catalog_id
    return typeof id === 'string' && desktopWorkspaceIconById(id) ? id : null
}

export const desktopWorkspaceIconUpdateSchema = z.object({
    name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX),
    catalogId: z.string().min(1).max(200).nullable().optional(),
}).strict()
export type DesktopWorkspaceIconUpdate = z.infer<typeof desktopWorkspaceIconUpdateSchema>

// Name and illustration are one original workspace-settings save. Omission preserves the icon;
// an explicit null resets to the default. Validation precedes every persistent mutation.
export async function writeDesktopWorkspaceIcon(db: Client, input: DesktopWorkspaceIconUpdate): Promise<{ name: string; catalogId: string | null }> {
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
        if (catalogId === null) await transaction.execute('DELETE FROM desktop_workspace_icon WHERE workspace_id=1')
        else if (catalogId !== undefined) await transaction.execute({
            sql: 'INSERT INTO desktop_workspace_icon (workspace_id,catalog_id,created_at,updated_at) VALUES (1,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET catalog_id=excluded.catalog_id,updated_at=excluded.updated_at',
            args: [catalogId, now, now],
        })
        const saved = (await transaction.execute(`SELECT w.name,i.catalog_id FROM desktop_workspace w
            LEFT JOIN desktop_workspace_icon i ON i.workspace_id=w.id WHERE w.id=1`)).rows[0]
        const stored = saved.catalog_id
        const result = { name: String(saved.name), catalogId: typeof stored === 'string' && desktopWorkspaceIconById(stored) ? stored : null }
        await transaction.commit()
        return result
    } finally { transaction.close() }
}
