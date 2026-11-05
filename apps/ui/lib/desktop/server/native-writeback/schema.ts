// No runtime/file-publisher imports: safe for numbered database migrations.
export const nativeWritebackSchema=`CREATE TABLE IF NOT EXISTS desktop_native_writeback (
 id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,engine_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS desktop_native_writeback_files (
 proposal_id TEXT NOT NULL REFERENCES desktop_native_writeback(id) ON DELETE CASCADE,path TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(proposal_id,path));`
