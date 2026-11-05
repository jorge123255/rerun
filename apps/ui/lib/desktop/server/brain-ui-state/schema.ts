import 'server-only'
import type { Client } from '@libsql/client'

export const brainUiStateSchema = `
CREATE TABLE IF NOT EXISTS desktop_brain_ui_state (
    profile_id INTEGER NOT NULL CHECK(profile_id = 1),
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    value TEXT,
    PRIMARY KEY(profile_id,key)
);
CREATE TABLE IF NOT EXISTS desktop_brain_ui_writes (
    profile_id INTEGER NOT NULL CHECK(profile_id = 1),
    request_id TEXT NOT NULL,
    key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY(profile_id,request_id)
);`
export async function initializeDesktopBrainUiState(db: Client): Promise<void> {
    await db.executeMultiple(brainUiStateSchema)
}
