import 'server-only'
import { messagePreview, messageSchema, sessionsListSchema, visibleText, type Message } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopCoworkerPreviewsSchema, type DesktopCoworkerPreviews } from '../coworker-previews'

const messagesSchema = z.object({ messages: z.array(messageSchema) })
const READ_TIMEOUT_MS = 2_500

// What the engine knows that the workspace database does not: when each conversation last moved,
// and what was said in it. Either read may fail; the list then falls back to what is saved here.
export type CoworkerPreviewEngine = {
    sessions(engineAgentId: string, signal: AbortSignal): Promise<{ id: string; updatedAt: string }[]>
    messages(engineAgentId: string, engineSessionId: string, signal: AbortSignal): Promise<Message[]>
}

export function coworkerPreviewEngine(read: <T>(path: string, signal: AbortSignal, parse: (value: unknown) => T) => Promise<T>): CoworkerPreviewEngine {
    return {
        sessions: (agent, signal) => read(`/agents/${encodeURIComponent(agent)}/sessions`, signal, value => sessionsListSchema.parse(value).sessions),
        messages: (agent, session, signal) => read(`/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/messages`, signal, value => messagesSchema.parse(value).messages),
    }
}

function parsed(json: string): unknown {
    try { return JSON.parse(json) } catch { return json }
}

// The last thing a person or the coworker said, as one line. Tool rows and turns without words are skipped.
export function lastMessageOf(messages: readonly Message[]): { text: string; mine: boolean } | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message.role === 'tool') continue
        const content = parsed(message.contentJson)
        const words = content && typeof content === 'object' && !Array.isArray(content) && typeof (content as { text?: unknown }).text === 'string'
            ? (content as { text: string }).text : visibleText(content, '')
        const text = messagePreview(words)
        if (text) return { text, mine: message.role === 'user' }
    }
    return null
}

// One row per coworker of this workspace that has a conversation: the one that moved last. A
// coworker being removed is left out, as on the board.
export async function readDesktopCoworkerPreviews(db: Pick<Client, 'execute'>, engine?: CoworkerPreviewEngine, stop?: AbortSignal): Promise<DesktopCoworkerPreviews> {
    const { rows } = await db.execute(`SELECT s.id, s.agent_id, a.engine_agent_id, s.engine_session_id, s.title, s.updated_at FROM desktop_sessions s
        JOIN desktop_agents a ON a.id = s.agent_id AND a.workspace_id = 1
        WHERE NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id)
        ORDER BY s.agent_id, s.updated_at, s.id`)
    const byAgent = new Map<string, typeof rows>()
    for (const row of rows) byAgent.set(String(row.agent_id), [...byAgent.get(String(row.agent_id)) ?? [], row])
    const signal = AbortSignal.any([AbortSignal.timeout(READ_TIMEOUT_MS), ...(stop ? [stop] : [])])
    const previews = await Promise.all([...byAgent].map(async ([agentId, sessions]) => {
        const engineAgentId = typeof sessions[0].engine_agent_id === 'string' ? sessions[0].engine_agent_id : null
        const moved = engine && engineAgentId ? await engine.sessions(engineAgentId, signal).then(list => new Map(list.map(session => [session.id, session.updatedAt])), () => null) : null
        const dated = sessions.map(row => ({ row, updatedAt: moved?.get(String(row.engine_session_id)) ?? String(row.updated_at) }))
        // Rows arrive oldest first, so a tie keeps the later one.
        const latest = dated.reduce((best, next) => next.updatedAt >= best.updatedAt ? next : best)
        const lastMessage = moved && engine && engineAgentId
            ? await engine.messages(engineAgentId, String(latest.row.engine_session_id), signal).then(lastMessageOf, () => undefined) : undefined
        return [agentId, { title: String(latest.row.title), updatedAt: latest.updatedAt, ...(lastMessage !== undefined && { lastMessage }) }] as const
    }))
    return desktopCoworkerPreviewsSchema.parse({ previews: Object.fromEntries(previews) })
}
