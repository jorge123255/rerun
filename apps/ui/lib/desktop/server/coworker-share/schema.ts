import 'server-only'
import type { Client } from '@libsql/client'

export const desktopCoworkerShareSchema = `
CREATE TABLE IF NOT EXISTS desktop_coworker_shares (
    snapshot_id TEXT PRIMARY KEY,
    source_agent_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    include_json TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    archive_blob BLOB,
    archive_sha256 TEXT NOT NULL,
    archive_bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_coworker_share_imports (
    snapshot_id TEXT NOT NULL REFERENCES desktop_coworker_shares(snapshot_id) ON DELETE CASCADE,
    target_workspace_id INTEGER NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    imported_agent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('imported', 'rolled_back')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, target_workspace_id)
);
CREATE TABLE IF NOT EXISTS desktop_coworker_share_receipts (
    request_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('export', 'import', 'revoke')),
    snapshot_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created', 'imported', 'revoked', 'uncertain')),
    recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
    reason TEXT,
    created_at TEXT NOT NULL
);`

const initialized = new WeakMap<Client, Promise<void>>()
export function ensureDesktopCoworkerShareSchema(db: Client): Promise<void> {
    let work = initialized.get(db)
    if (!work) {
        work = (async () => {
            const tx = await db.transaction('write')
            try { await tx.executeMultiple(desktopCoworkerShareSchema); await tx.commit() }
            catch (error) { await tx.rollback().catch(() => undefined); throw error }
            finally { tx.close() }
        })()
        initialized.set(db, work)
        void work.catch(() => { if (initialized.get(db) === work) initialized.delete(db) })
    }
    return work
}
