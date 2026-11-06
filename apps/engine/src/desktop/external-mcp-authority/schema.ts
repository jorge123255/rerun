/** External keys and receipts. The one-time secret is not a column. Not system.db. */
export const DESKTOP_EXTERNAL_MCP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_external_mcp_keys (
  key_id TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revision INTEGER NOT NULL,
  secret_delivered INTEGER NOT NULL,
  create_request_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS desktop_external_mcp_keys_workspace
  ON desktop_external_mcp_keys(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS desktop_external_mcp_receipts (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL
);
`
