import 'server-only'
import type { Client } from '@libsql/client'
import { stdioInput, type StdioConnection } from '../mcp-stdio/store'

export async function assignedVaultMcpPrograms(db: Client, owner: string): Promise<StdioConnection[]> {
    const { rows } = await db.execute({
        sql: `SELECT p.name,p.executable,p.args,p.revision,p.executable_identity
            FROM desktop_vault_mcp_programs p
            JOIN desktop_agents a ON a.id=? AND a.workspace_id=1
            WHERE (p.shared_with_all=1 OR EXISTS (
                SELECT 1 FROM desktop_vault_mcp_program_attachments t WHERE t.item_id=p.id AND t.agent_id=a.id
            ))
            AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)
            AND NOT EXISTS (SELECT 1 FROM desktop_remote_mcp r WHERE r.agent_id=a.id AND r.name=p.name)
            AND NOT EXISTS (SELECT 1 FROM desktop_mcp_stdio s WHERE s.owner=a.id AND s.name=p.name)
            ORDER BY p.name LIMIT 17`,
        args: [owner],
    })
    return rows.map(row => {
        if (typeof row.executable_identity !== 'string' || !row.executable_identity) throw new Error('Local Vault program is missing executable approval')
        const revision = String(row.revision)
        return {
            ...stdioInput.parse({ name: row.name, executable: row.executable, args: JSON.parse(String(row.args)), revision }),
            revision, transport: 'stdio', approvedExecutable: row.executable_identity,
        }
    })
}
