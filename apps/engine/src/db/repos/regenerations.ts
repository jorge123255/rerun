import type { InStatement } from '@libsql/client'
import { newId, nowIso } from '../../lib/ids.js'
import { HttpError, notFound } from '../../lib/errors.js'
import { getSystemDb } from '../systemDb.js'
import { extractText, listMessages, storedContent } from './messages.js'
import type { SessionRow } from '../schema.js'

export type RegenerationTarget = { sessionId: string; regenerateMessageId: string; requestId: string }

// A lost response can be replayed after the engine has restarted, including when the run failed.
export async function getRegeneration(agentId: string, target: RegenerationTarget) {
    const { client } = await getSystemDb(agentId)
    const result = await client.execute({ sql: 'SELECT * FROM desktop_regenerations WHERE request_id = ?', args: [target.requestId] })
    const row = result.rows[0]
    if (!row) return null
    if (row.source_session_id !== target.sessionId || row.source_message_id !== target.regenerateMessageId) {
        throw new HttpError(409, 'That retry belongs to a different reply.')
    }
    return { sessionId: String(row.session_id), runId: String(row.run_id) }
}

export async function forkReply(agentId: string, source: SessionRow, target: RegenerationTarget) {
    const { client } = await getSystemDb(agentId)
    const messages = await listMessages(agentId, source.id)
    const index = messages.findIndex(row => row.id === target.regenerateMessageId)
    if (index === -1) throw notFound('reply')
    const reply = messages[index]
    if (reply.role !== 'assistant' || !extractText(storedContent(reply.contentJson)).trim()) throw new HttpError(409, 'Choose a saved assistant reply with text.')
    const unsuccessful = await client.execute({
        sql: "SELECT id FROM runs WHERE session_id = ? AND status IN ('error', 'cancelled') AND started_at <= ? AND finished_at >= ? LIMIT 1",
        args: [source.id, reply.createdAt, reply.createdAt],
    })
    if (unsuccessful.rows.length) throw new HttpError(409, 'Choose a completed assistant reply.')
    const turn = messages.slice(0, index).findLastIndex(row => row.role === 'user')
    if (turn < 0) throw new HttpError(409, 'This reply has no preceding user message.')
    const sessionId = newId()
    const runId = newId()
    const now = nowIso()
    const statements: InStatement[] = [
        { sql: 'INSERT INTO desktop_regenerations (request_id, source_session_id, source_message_id, session_id, run_id) VALUES (?,?,?,?,?)', args: [target.requestId, source.id, reply.id, sessionId, runId] },
        { sql: 'INSERT INTO sessions (id, agent_id, title, source, origin_agent_id, origin_session_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', args: [sessionId, agentId, source.title, source.source, agentId, source.id, now, now] },
        { sql: 'INSERT INTO runs (id, agent_id, session_id, started_at) VALUES (?,?,?,?)', args: [runId, agentId, sessionId, now] },
    ]
    // Copied history predates the new run, whose output is looked up by its start/end timestamps.
    const beforeRun = new Date(Date.parse(now) - 1).toISOString()
    const prefix = messages.slice(0, turn + 1).map(row => ({ ...row, id: newId(), sessionId, createdAt: row.createdAt < now ? row.createdAt : beforeRun }))
    for (const row of prefix) {
        statements.push({ sql: 'INSERT INTO messages (id, session_id, role, content_json, tool_calls_json, created_at, author_id, author_name) VALUES (?,?,?,?,?,?,?,?)', args: [row.id, sessionId, row.role, row.contentJson, row.toolCallsJson, row.createdAt, row.authorId, row.authorName] })
        const text = extractText(storedContent(row.contentJson))
        if (text) statements.push({ sql: 'INSERT INTO messages_fts(content, message_id) VALUES (?,?)', args: [text, row.id] })
    }
    // Prefix, request receipt and run appear together, so a retry never picks up a half-made chat.
    try {
        await client.batch(statements, 'write')
    } catch (error) {
        const existing = await getRegeneration(agentId, target)
        if (existing) return { ...existing, user: null }
        throw error
    }
    return { sessionId, runId, user: prefix[turn] }
}
