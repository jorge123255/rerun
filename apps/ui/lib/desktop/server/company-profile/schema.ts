import 'server-only'
import type { Client } from '@libsql/client'

export const DESKTOP_COMPANY_PROFILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_company_profile_attempts (
    request_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('decide','enrich')),
    fingerprint TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_company_profile_attempts_chat
    ON desktop_company_profile_attempts(workspace_id,chat_id,kind,updated_at);
`

export async function ensureDesktopCompanyProfileSchema(db: Client): Promise<void> {
    await db.executeMultiple(DESKTOP_COMPANY_PROFILE_SCHEMA_SQL)
}
