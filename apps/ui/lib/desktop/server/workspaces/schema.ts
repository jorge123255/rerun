import 'server-only'

/**
 * Additive migration SQL for root. Do not apply from this package — root appends a
 * numbered desktop_schema_migrations step. File-backed catalog in main remains the
 * cold-launch source of truth; these tables optionally mirror catalog rows for SQL
 * joins once root activates W1.
 *
 * Suggested next version after round33's 24: version 25, id 'local-workspace-catalog'.
 */
export const DESKTOP_LOCAL_WORKSPACES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_local_workspaces (
    workspace_id INTEGER PRIMARY KEY CHECK (workspace_id >= 1),
    name TEXT NOT NULL CHECK (length(trim(name)) >= 1 AND length(name) <= 60),
    icon_catalog_id TEXT,
    directory_name TEXT NOT NULL UNIQUE CHECK (directory_name = CAST(workspace_id AS TEXT)),
    create_request_id TEXT UNIQUE,
    rename_request_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_local_workspace_selection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workspace_id INTEGER NOT NULL REFERENCES desktop_local_workspaces(workspace_id),
    published_by_receipt_id TEXT,
    selected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_local_workspace_switches (
    receipt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    from_workspace_id INTEGER NOT NULL,
    to_workspace_id INTEGER NOT NULL,
    phase TEXT NOT NULL,
    install_id TEXT NOT NULL,
    reason TEXT,
    admissions_frozen INTEGER NOT NULL DEFAULT 0 CHECK (admissions_frozen IN (0, 1)),
    old_runtime_closed INTEGER NOT NULL DEFAULT 0 CHECK (old_runtime_closed IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO desktop_local_workspaces(workspace_id, name, icon_catalog_id, directory_name, created_at, updated_at)
SELECT 1, name, NULL, '1', created_at, updated_at FROM desktop_workspace WHERE id = 1;
INSERT OR IGNORE INTO desktop_local_workspace_selection(id, workspace_id, published_by_receipt_id, selected_at)
SELECT 1, 1, NULL, COALESCE((SELECT updated_at FROM desktop_workspace WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`

export const DESKTOP_LOCAL_WORKSPACES_MIGRATION = {
    version: 25,
    id: 'local-workspace-catalog',
    sql: DESKTOP_LOCAL_WORKSPACES_SCHEMA_SQL,
} as const
