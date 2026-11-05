import type { Client } from '@libsql/client'

export async function initializeDesktopCreation(db: Client) {
    await db.executeMultiple(`CREATE TABLE IF NOT EXISTS desktop_creations (
        request_id TEXT PRIMARY KEY, intent TEXT NOT NULL, agent_id TEXT NOT NULL UNIQUE,
        config TEXT NOT NULL, space_id TEXT NOT NULL, board_col INTEGER NOT NULL, board_row INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('reserved','created','started')),
        session_id TEXT, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)), created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS desktop_creation_pending ON desktop_creations((1)) WHERE acknowledged=0;`)
}
