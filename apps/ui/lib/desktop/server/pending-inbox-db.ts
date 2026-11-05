import type { Client } from '@libsql/client'

// Independent of routes/database so the receipts table exists before the first pending-inbox
// read, and so `database.ts` (root-owned) can wire it into startup without an import cycle.
export const DESKTOP_PENDING_INBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_pending_inbox_seen (
    item_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'approval')),
    seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_pending_inbox_seen_v2 (
    item_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'approval', 'takeover')),
    seen_at TEXT NOT NULL
);
INSERT OR IGNORE INTO desktop_pending_inbox_seen_v2 SELECT * FROM desktop_pending_inbox_seen;
`

const initialized = new WeakMap<Client, Promise<void>>()
export async function initializeDesktopPendingInbox(db: Client): Promise<void> {
    let work = initialized.get(db)
    if (!work) {
        work = db.executeMultiple(DESKTOP_PENDING_INBOX_SCHEMA + `
            CREATE TABLE IF NOT EXISTS desktop_pending_inbox_seen_v3 (
                item_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('question','approval','takeover','service')),
                seen_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO desktop_pending_inbox_seen_v3 SELECT * FROM desktop_pending_inbox_seen_v2;
        `)
        initialized.set(db, work)
    }
    await work
}
