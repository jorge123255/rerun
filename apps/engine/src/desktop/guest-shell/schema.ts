/** Per-coworker immutable invocation ledger. Command text stays in the provider's tool call. */
export const DESKTOP_GUEST_SHELL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_guest_shell_requests (
 request_id TEXT PRIMARY KEY,
 fingerprint TEXT NOT NULL,
 identity TEXT NOT NULL,
 receipt TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
`
