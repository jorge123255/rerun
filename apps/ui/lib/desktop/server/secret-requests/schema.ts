import 'server-only'
import type { Client } from '@libsql/client'

export const desktopSecretRequestSchema = `
CREATE TABLE IF NOT EXISTS desktop_secret_requests (
    request_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    ordered_input TEXT NOT NULL,
    reason TEXT,
    revision TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sealed', 'accepted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(agent_id, session_id, tool_call_id)
);
CREATE TABLE IF NOT EXISTS desktop_secret_credentials (
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    sealed_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(agent_id, key)
);
CREATE TABLE IF NOT EXISTS desktop_secret_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES desktop_secret_requests(request_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('save', 'skip', 'dismiss')),
    expected_revision TEXT NOT NULL,
    body_fingerprint TEXT NOT NULL,
    sealed_payload TEXT,
    credential_versions TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'sealed', 'refused')),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_secret_receipts (
    request_id TEXT PRIMARY KEY REFERENCES desktop_secret_requests(request_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES desktop_secret_attempts(attempt_id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('save', 'skip', 'dismiss')),
    provided_keys TEXT NOT NULL,
    skipped_keys TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    continuation_request_id TEXT NOT NULL UNIQUE,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
    created_at TEXT NOT NULL
);`

const initialized = new WeakMap<Client, Promise<void>>()
export function ensureDesktopSecretRequestSchema(db: Client): Promise<void> {
    let work = initialized.get(db)
    if (!work) {
        work = (async () => {
            const tx = await db.transaction('write')
            try { await tx.executeMultiple(desktopSecretRequestSchema); await tx.commit() }
            catch (error) { await tx.rollback().catch(() => undefined); throw error }
            finally { tx.close() }
        })()
        initialized.set(db, work)
        void work.catch(() => { if (initialized.get(db) === work) initialized.delete(db) })
    }
    return work
}
