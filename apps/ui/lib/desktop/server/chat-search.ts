import 'server-only'
import type { Client } from '@libsql/client'
import { conversationSearchKey, type DesktopConversationHit } from '../chat-search'
import { DesktopHttpError } from './auth'
import { findDesktopAgent } from './store'

export async function searchDesktopChats(db: Client, text: string, agentId?: string): Promise<{ hits: DesktopConversationHit[]; hasMore: boolean }> {
    // A supplied scope must resolve to this workspace even for a short query. Never turn an
    // unknown or deleted coworker into an unscoped search of someone else's conversations.
    if (agentId !== undefined && !await findDesktopAgent(db, agentId)) throw new DesktopHttpError(404, 'Coworker not found')
    const needle = conversationSearchKey(text)
    if (needle.length < 2) return { hits: [], hasMore: false }
    const result = await db.execute({
        sql: `SELECT s.id, s.agent_id, s.title, a.name AS agent_name
              FROM desktop_sessions s JOIN desktop_agents a ON a.id = s.agent_id
              WHERE a.workspace_id = 1 AND instr(coalesce(s.title_search, lower(s.title)), ?) > 0
              ${agentId === undefined ? '' : 'AND a.id = ?'}
              ORDER BY s.created_at DESC, s.rowid DESC LIMIT 51`,
        args: agentId === undefined ? [needle] : [needle, agentId],
    })
    return {
        hits: result.rows.slice(0, 50).map(row => ({ id: String(row.id), agentId: String(row.agent_id), title: String(row.title), agentName: String(row.agent_name) })),
        hasMore: result.rows.length > 50,
    }
}
