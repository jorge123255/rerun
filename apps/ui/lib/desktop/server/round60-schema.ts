import 'server-only'
import type { Client } from '@libsql/client'

// Outside-agent keys made for an import. Such a key reaches only the import tools and writes only
// to the one coworker it creates; `claim` holds the request that is creating it, so two calls
// cannot each make a coworker.
export async function initializeDesktopRound60(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 60, id = 'external-import-keys'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.execute(`CREATE TABLE desktop_external_import_keys (
                key_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                bound_agent_id TEXT,
                claim TEXT,
                created_at TEXT NOT NULL)`)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
