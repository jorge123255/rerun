import 'server-only'
import type { Client } from '@libsql/client'
import type { DesktopConversationHit } from '../chat-search'

export async function searchDesktopChats(db: Client, text: string): Promise<{ hits: DesktopConversationHit[]; hasMore: boolean }> {
    const result = await db.execute({
        sql: `SELECT s.id, s.agent_id, s.title, a.name AS agent_name
              FROM desktop_sessions s JOIN desktop_agents a ON a.id = s.agent_id
              WHERE a.workspace_id = 1 AND instr(lower(s.title), lower(?)) > 0
              ORDER BY s.created_at DESC, s.rowid DESC LIMIT 51`,
        args: [text],
    })
    return {
        hits: result.rows.slice(0, 50).map(row => ({ id: String(row.id), agentId: String(row.agent_id), title: String(row.title), agentName: String(row.agent_name) })),
        hasMore: result.rows.length > 50,
    }
}
