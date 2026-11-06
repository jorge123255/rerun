export const desktopClaudePlanSchema = `CREATE TABLE IF NOT EXISTS desktop_claude_plan_attempts (
 attempt_id TEXT PRIMARY KEY,
 attempt TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_claude_plan_chats (
 operation_id TEXT PRIMARY KEY,
 result TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
)`
