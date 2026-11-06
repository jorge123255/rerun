export const desktopToolInstallSchema = `
CREATE TABLE IF NOT EXISTS desktop_tool_installs (
 operation_id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE,
 identity TEXT NOT NULL, packages TEXT NOT NULL, snapshot TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_tool_install_requests (
 request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, identity TEXT NOT NULL,
 body TEXT NOT NULL, result TEXT,
 FOREIGN KEY(operation_id) REFERENCES desktop_tool_installs(operation_id)
);
`
