export const desktopBrainSemanticSchema = `CREATE TABLE IF NOT EXISTS desktop_brain_semantic_chunks (
 chunk_id TEXT PRIMARY KEY,
 page_hash TEXT NOT NULL,
 backend_fingerprint TEXT NOT NULL,
 entry TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_brain_semantic_pending (
 chunk_id TEXT PRIMARY KEY,
 pending TEXT NOT NULL,
 updated_at TEXT NOT NULL
)`
