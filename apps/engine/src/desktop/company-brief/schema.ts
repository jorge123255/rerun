// Additive and re-runnable. Root applies this from the data-dir fragment in the round 35 B handoff.
// The store does not create it on read.
export const DESKTOP_COMPANY_BRIEF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_company_briefs (
    request_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    discovery_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    model_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    draft_text TEXT,
    draft_revision INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_company_briefs_chat_idx ON desktop_company_briefs(workspace_id, chat_id, updated_at);
CREATE TABLE IF NOT EXISTS desktop_company_brief_context (
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    active INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, chat_id)
);
CREATE TABLE IF NOT EXISTS desktop_company_brief_handoffs (
    handoff_request_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
`
