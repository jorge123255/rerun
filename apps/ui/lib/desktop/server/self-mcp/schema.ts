// Additive shared-database migration. No connections or provider work at startup.
export const desktopSelfMcpSchema = `
CREATE TABLE IF NOT EXISTS desktop_self_mcp_proposals (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 id TEXT NOT NULL, invocation TEXT NOT NULL, revision INTEGER NOT NULL,
 status TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,id), UNIQUE(owner,invocation)
);
CREATE TABLE IF NOT EXISTS desktop_self_mcp_decisions (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 id TEXT NOT NULL, proposal_id TEXT NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(owner,id), FOREIGN KEY(owner,proposal_id) REFERENCES desktop_self_mcp_proposals(owner,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS desktop_self_mcp_receipts (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 decision_id TEXT NOT NULL, proposal_id TEXT NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(owner,decision_id), FOREIGN KEY(owner,proposal_id) REFERENCES desktop_self_mcp_proposals(owner,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS desktop_self_mcp_effects (
 owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 decision_id TEXT NOT NULL, identity TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(owner,decision_id)
);
CREATE TABLE IF NOT EXISTS desktop_self_mcp_config_revisions (
 owner TEXT PRIMARY KEY REFERENCES desktop_agents(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0
);
` + [
    ['desktop_remote_mcp', 'agent_id'], ['desktop_remote_mcp_oauth', 'agent_id'], ['desktop_mcp_stdio', 'owner'], ['desktop_service_installs', 'owner'],
].flatMap(([table, owner]) => ['INSERT', 'UPDATE', 'DELETE'].map(operation => {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW'
    return `CREATE TRIGGER IF NOT EXISTS self_mcp_revision_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
    BEGIN
      INSERT INTO desktop_self_mcp_config_revisions(owner,revision)
      SELECT id,1 FROM desktop_agents WHERE id=${row}.${owner}
      ON CONFLICT(owner) DO UPDATE SET revision=revision+1;
    END;`
})).join('\n')
