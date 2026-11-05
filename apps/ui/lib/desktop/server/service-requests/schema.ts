import 'server-only'
import type { Client } from '@libsql/client'

// Distinct from desktop_service_requests, which records Apps install mutations. No credential columns.
export const desktopServiceSuggestionSchema = `
CREATE TABLE IF NOT EXISTS desktop_service_suggestion_requests (
    service_request_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES desktop_sessions(id) ON DELETE CASCADE,
    source_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    ordered_input TEXT NOT NULL,
    revision TEXT NOT NULL,
    current_index INTEGER NOT NULL,
    choices TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_service_suggestion_mutations (
    request_id TEXT PRIMARY KEY,
    service_request_id TEXT NOT NULL REFERENCES desktop_service_suggestion_requests(service_request_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('progress', 'finish')),
    expected_revision TEXT NOT NULL,
    body TEXT NOT NULL,
    result_revision TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_service_suggestion_retry (
    service_request_id TEXT PRIMARY KEY REFERENCES desktop_service_suggestion_requests(service_request_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_service_suggestion_rejections (
    request_id TEXT PRIMARY KEY,
    service_request_id TEXT NOT NULL REFERENCES desktop_service_suggestion_requests(service_request_id) ON DELETE CASCADE,
    body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_service_suggestion_receipts (
    service_request_id TEXT PRIMARY KEY REFERENCES desktop_service_suggestion_requests(service_request_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL UNIQUE,
    revision TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    entries TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
    created_at TEXT NOT NULL
);`

const initialized = new WeakMap<Client, Promise<void>>()
export function ensureDesktopServiceSuggestionSchema(db: Client): Promise<void> {
    let work = initialized.get(db)
    if (!work) {
        // A dedicated transaction cannot roll back somebody else's active write.
        work = (async () => {
            const tx = await db.transaction('write')
            try { await tx.executeMultiple(desktopServiceSuggestionSchema); await tx.commit() }
            catch (error) { await tx.rollback().catch(() => undefined); throw error }
            finally { tx.close() }
        })()
        initialized.set(db, work)
        void work.catch(() => { if (initialized.get(db) === work) initialized.delete(db) })
    }
    return work
}
