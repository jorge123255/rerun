import type { Client } from '@libsql/client'

export const browserExportSchema = `
CREATE TABLE IF NOT EXISTS desktop_browser_exports (
 operation_key TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 digest TEXT NOT NULL, source_fingerprint TEXT NOT NULL, source_json TEXT NOT NULL, files_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('claimed','settled')), result_json TEXT,
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes > 0), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS desktop_browser_export_files (
 operation_key TEXT NOT NULL REFERENCES desktop_browser_exports(operation_key) ON DELETE CASCADE,
 file_index INTEGER NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL,
 parent_json TEXT, temp_name TEXT, dev TEXT, ino TEXT, state TEXT NOT NULL DEFAULT 'planned',
 PRIMARY KEY(operation_key,file_index));`

export async function ensureDesktopBrowserExportsSchema(db: Client): Promise<void> {
    await db.executeMultiple(browserExportSchema)
}
