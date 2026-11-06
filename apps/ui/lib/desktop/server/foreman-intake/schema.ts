import type { Client } from '@libsql/client'

/** Additive SQL for root's central migration ladder. Owned fragment — do not apply from this lane. */
export const DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_foreman_intake_sessions (
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  draft TEXT NOT NULL,
  decided_industry TEXT,
  known_first_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, chat_id)
);
CREATE TABLE IF NOT EXISTS desktop_foreman_intake_writes (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_foreman_intake_completions (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_foreman_intake_completions_chat
  ON desktop_foreman_intake_completions(workspace_id, chat_id, updated_at);
`

export async function ensureDesktopForemanIntakeSchema(db: Client): Promise<void> {
    await db.executeMultiple(DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL)
}
