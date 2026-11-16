import 'server-only'
import type { Client } from '@libsql/client'

// One row per time a routine was switched off after ten failed runs in a row: the notice that
// reaches the person whatever the coworker's notification rule says, and its inbox item.
export async function initializeDesktopRound70(db: Client) {
    const tx = await db.transaction('write')
    try {
        const version = 70, id = 'routine-auto-off-notices'
        const prior = (await tx.execute({ sql: 'SELECT id FROM desktop_schema_migrations WHERE version=?', args: [version] })).rows[0]
        if (prior && prior.id !== id) throw new Error('Desktop migration identity mismatch')
        if (!prior) {
            await tx.executeMultiple(`
                CREATE TABLE desktop_routine_auto_off_notices (
                    id TEXT PRIMARY KEY,
                    workspace_id INTEGER NOT NULL,
                    agent_engine_id TEXT NOT NULL,
                    agent_local_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
                    session_engine_id TEXT NOT NULL,
                    session_local_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
                    slug TEXT NOT NULL,
                    routine_name TEXT NOT NULL,
                    disabled_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    acknowledged_at TEXT,
                    UNIQUE (agent_engine_id, slug, disabled_at)
                );
                CREATE INDEX desktop_routine_auto_off_notices_open_idx ON desktop_routine_auto_off_notices(workspace_id, acknowledged_at, created_at);
            `)
            await tx.execute({ sql: 'INSERT INTO desktop_schema_migrations(version,id) VALUES(?,?)', args: [version, id] })
        }
        await tx.commit()
    } finally { tx.close() }
}
