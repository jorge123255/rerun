import 'server-only'
import type { Client } from '@libsql/client'

// How this workspace is shown on this Mac, and the coworker its Simple view had open last. The
// app's local address changes with every launch, so the browser's own storage cannot keep either.
export async function initializeDesktopRound59(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 59, id = 'workspace-view'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute(`CREATE TABLE desktop_workspace_view (
                workspace_id INTEGER PRIMARY KEY CHECK(workspace_id=1),
                view TEXT CHECK(view IN ('board','simple')),
                last_opened TEXT)`)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
