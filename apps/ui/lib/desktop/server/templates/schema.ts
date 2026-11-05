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

export async function initializeDesktopTemplates(db: Pick<Client, 'executeMultiple'>): Promise<void> {
    await db.executeMultiple(DESKTOP_TEMPLATE_SCHEMA_SQL)
}
