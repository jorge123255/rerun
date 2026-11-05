// No lifecycle/runtime imports: safe for numbered database migrations.
export const stdioSchema=`CREATE TABLE IF NOT EXISTS desktop_mcp_stdio (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,name TEXT NOT NULL,executable TEXT NOT NULL,args TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(owner,name));
 CREATE TABLE IF NOT EXISTS desktop_mcp_stdio_calls (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,run_id TEXT NOT NULL,call_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,run_id,call_id));`
