export const VIEWS_TABLE = '_rerun_views'

// Created on the first write rather than when the database opens: most databases never get a view,
// and an agent reading its file with sqlite3 should not find a table it never made.
export const VIEWS_DDL = `CREATE TABLE IF NOT EXISTS ${VIEWS_TABLE} (id TEXT PRIMARY KEY, table_name TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (table_name, name))`

export const PORTABLE_DATABASE_RECEIPT_TABLE = '_rerun_portable_database_receipt'
