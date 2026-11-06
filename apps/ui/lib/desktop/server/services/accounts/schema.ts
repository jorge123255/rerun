import 'server-only'

import type { Client } from '@libsql/client'

/**
 * Additive tables for the existing desktop database. Root copies this into the
 * canonical service migration. The feature initializer is idempotent and does
 * not open a second database or a second keychain.
 *
 * `bundle` is AES-256-GCM ciphertext. It is not a plaintext header or secret.
 * Reservation `public_result` is the public result JSON only.
 */
export const DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_service_account_mutations (
    owner TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    phase TEXT NOT NULL,
    account_key TEXT,
    installation_id TEXT,
    revision TEXT,
    public_result TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner, request_id)
);
CREATE TABLE IF NOT EXISTS desktop_service_header_secrets (
    owner TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    bundle TEXT NOT NULL,
    PRIMARY KEY (owner, installation_id)
);
CREATE TABLE IF NOT EXISTS desktop_service_account_tombstones (
    owner TEXT NOT NULL,
    account_key TEXT NOT NULL,
    retired_at TEXT NOT NULL,
    PRIMARY KEY (owner, account_key)
);
CREATE TABLE IF NOT EXISTS desktop_service_account_attempts (
    owner TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    request_id TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
    PRIMARY KEY (owner, fingerprint),
    UNIQUE (owner, request_id)
);
`

export async function ensureDesktopServiceAccountSchema(db: Client): Promise<void> {
    for (const statement of DESKTOP_SERVICE_ACCOUNT_SCHEMA_SQL.split(';').map(part => part.trim()).filter(Boolean)) {
        await db.execute(statement)
    }
}
