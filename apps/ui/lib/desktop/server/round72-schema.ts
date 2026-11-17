import 'server-only'
import type { Client } from '@libsql/client'

// The Simple view's list on this Mac: the Boxes folded away, and where someone dragged a Box or a
// coworker (upstream #279-#281). Upstream keeps the folded Boxes in the browser and the order in
// two Supabase columns; the app's local address changes with every launch and it has no Supabase,
// so both live with the workspace. A rank is absent until someone arranges the list, which then
// follows the order things were made. A coworker's rank names the Box it was given in: in another
// Box it means nothing.
export async function initializeDesktopRound72(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 72, id = 'simple-list'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                CREATE TABLE desktop_sidebar_collapsed (box_id TEXT PRIMARY KEY);
                CREATE TABLE desktop_sidebar_order (
                    kind TEXT NOT NULL CHECK(kind IN ('box','agent')),
                    id TEXT NOT NULL,
                    box_id TEXT,
                    rank REAL NOT NULL,
                    PRIMARY KEY(kind,id),
                    CHECK((kind='agent') = (box_id IS NOT NULL)));
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
