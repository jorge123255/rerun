import 'server-only'
import type { Client } from '@libsql/client'

export const desktopMcpSignInSchema = `
CREATE TABLE IF NOT EXISTS desktop_mcp_sign_in_requests (
    request_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    server_snapshot TEXT NOT NULL,
    ordered_input TEXT NOT NULL,
    reason TEXT,
    active_attempt_id TEXT,
    revision TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'connecting', 'connected', 'declined', 'error')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(agent_id, session_id, tool_call_id)
);
CREATE TABLE IF NOT EXISTS desktop_mcp_sign_in_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES desktop_mcp_sign_in_requests(request_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('connect', 'decline')),
    expected_revision TEXT NOT NULL,
    body_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sealed', 'cancelled', 'failed')),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_mcp_sign_in_receipts (
    request_id TEXT PRIMARY KEY REFERENCES desktop_mcp_sign_in_requests(request_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES desktop_mcp_sign_in_attempts(attempt_id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('connected', 'declined')),
    summary_text TEXT NOT NULL,
    continuation_request_id TEXT NOT NULL UNIQUE,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
    created_at TEXT NOT NULL
);`

const initialized = new WeakMap<Client, Promise<void>>()
export function ensureDesktopMcpSignInSchema(db: Client): Promise<void> {
    let work = initialized.get(db)
    if (!work) {
        work = (async () => {
            const tx = await db.transaction('write')
            try { await tx.executeMultiple(desktopMcpSignInSchema); await tx.commit() }
            catch (error) { await tx.rollback().catch(() => undefined); throw error }
            finally { tx.close() }
        })()
        initialized.set(db, work)
        void work.catch(() => { if (initialized.get(db) === work) initialized.delete(db) })
    }
    return work
}
