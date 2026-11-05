import 'server-only'
import type { Client } from '@libsql/client'

// Root applies this from database initialize as well. The factory also runs it so the
// first template request is durable before that startup edit lands.
export const DESKTOP_TEMPLATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_template_requests (
    request_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE,
    operation TEXT NOT NULL,
    template_id TEXT,
    revision TEXT,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`

const initialized = new WeakMap<object, Promise<void>>()
export async function initializeDesktopTemplates(db: Pick<Client, 'executeMultiple'>): Promise<void> {
    let pending = initialized.get(db)
    if (!pending) {
        pending = db.executeMultiple(DESKTOP_TEMPLATE_SCHEMA_SQL + `
            CREATE TABLE IF NOT EXISTS desktop_template_rotations (
                request_id TEXT PRIMARY KEY, key TEXT NOT NULL, operation TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS desktop_template_intents (
                key TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, operation TEXT NOT NULL
            );
        `)
        initialized.set(db, pending)
    }
    await pending
}
