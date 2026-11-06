export const DESKTOP_TRIGGER_HUMAN_SQL = `
CREATE TABLE IF NOT EXISTS desktop_trigger_human_admissions (
 source_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, session_id TEXT NOT NULL,
 source_run_id TEXT NOT NULL, source_message_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
 kind TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS desktop_trigger_human_stops (
 source_key TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL,
 session_id TEXT NOT NULL, source_run_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
 tool_call_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','stopped'))
);
`
