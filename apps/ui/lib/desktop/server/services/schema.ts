export const desktopServicesSchema=`CREATE TABLE IF NOT EXISTS desktop_service_installs (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,key TEXT NOT NULL,id TEXT NOT NULL UNIQUE,schema_version INTEGER NOT NULL DEFAULT 1,
 engine_id TEXT NOT NULL,slug TEXT NOT NULL,method_id TEXT NOT NULL,revision TEXT NOT NULL,state TEXT NOT NULL,plan TEXT NOT NULL,bearer TEXT,
 skills TEXT NOT NULL DEFAULT '[]',tool_names TEXT NOT NULL DEFAULT '[]',health TEXT NOT NULL,health_launch TEXT,installed_at TEXT NOT NULL,PRIMARY KEY(owner,key));
 CREATE TABLE IF NOT EXISTS desktop_service_requests (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,request_id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,
 PRIMARY KEY(owner,request_id));
 CREATE TABLE IF NOT EXISTS desktop_service_calls (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,run_id TEXT NOT NULL,call_id TEXT NOT NULL,PRIMARY KEY(owner,run_id,call_id));`
