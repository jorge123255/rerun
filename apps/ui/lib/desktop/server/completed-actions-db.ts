import type { Client } from '@libsql/client'

// Independent of routes/database so startup activates the cutoff before the first chat.
export const DESKTOP_COMPLETIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_completions_seen (
    completion_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_completions_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled_at TEXT NOT NULL
);
`

export async function initializeDesktopCompletions(db: Client): Promise<void> {
    await db.executeMultiple(DESKTOP_COMPLETIONS_SCHEMA)
    await db.execute({ sql: 'INSERT OR IGNORE INTO desktop_completions_state (id, enabled_at) VALUES (1, ?)', args: [new Date().toISOString()] })
}
