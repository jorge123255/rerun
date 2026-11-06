/** Mutation receipts only. Routine definitions stay in the existing schedule files. */
export const DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_schedule_tool_intents (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  slug TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  result_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS desktop_schedule_tool_one_pending ON desktop_schedule_tool_intents(slug) WHERE result_json IS NULL;
`
