import 'server-only'
import type { Client } from '@libsql/client'

export type McpSignInOwner = {
    workspaceId: string
    owner: string
    sessionId: string
    engineAgentId: string
    engineSessionId: string
}

/** Each isolated desktop database stores its active workspace under local id 1. */
export async function hasExactMcpSignInOwner(query: Pick<Client, 'execute'>, owner: McpSignInOwner): Promise<boolean> {
    const exact = await query.execute({
        sql: `SELECT a.id FROM desktop_agents a JOIN desktop_sessions s ON s.agent_id=a.id
            WHERE a.id=? AND a.engine_agent_id=? AND a.workspace_id=1 AND s.id=? AND s.engine_session_id=?
                AND (SELECT COUNT(*) FROM (SELECT 1 FROM desktop_sessions alias WHERE alias.engine_session_id=s.engine_session_id LIMIT 2))=1
                AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)`,
        args: [owner.owner, owner.engineAgentId, owner.sessionId, owner.engineSessionId],
    })
    return exact.rows.length === 1
}
