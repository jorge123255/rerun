import 'server-only'
import type { Client } from '@libsql/client'

// Work that waits for a plan to reset: the owner's optional backup model, and the one chat message
// per conversation queued to be sent when its plan has usage again.
export async function initializeDesktopRound68(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 68, id = 'usage-limit-gate'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                CREATE TABLE desktop_usage_backup_model (id INTEGER PRIMARY KEY CHECK (id = 1), connection_id TEXT NOT NULL, model TEXT NOT NULL);
                CREATE TABLE desktop_usage_chat_waits (
                    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT, text TEXT NOT NULL,
                    connection_id TEXT NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL,
                    resets_at TEXT, next_check_at TEXT NOT NULL, recheck_since TEXT,
                    state TEXT NOT NULL CHECK(state IN ('waiting','sending','sent','cancelled','held')),
                    reason TEXT, settled_at TEXT);
                CREATE UNIQUE INDEX desktop_usage_chat_waits_one ON desktop_usage_chat_waits(agent_id, COALESCE(session_id,''))
                    WHERE state IN ('waiting','sending');
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
