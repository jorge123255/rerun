export const desktopToolInstallSchema = `CREATE TABLE IF NOT EXISTS desktop_tool_installs (
 operation_id TEXT PRIMARY KEY,
 identity TEXT NOT NULL,
 snapshot TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
)`
