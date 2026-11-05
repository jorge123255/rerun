import { createHash } from 'node:crypto'
import { isContextPart, workspaceAttachmentParts, workspaceAttachmentPaths, type DesktopWorkspaceAttachment, type MessageAuthor } from '@rerun/contracts'
import { getSystemDb } from '../systemDb.js'
import type { MessageRow } from '../schema.js'
import { HttpError } from '../../lib/errors.js'
import { newId, nowIso } from '../../lib/ids.js'

export type DesktopFirstTurn = { sessionId: string; runId: string; message: string; attachments?: DesktopWorkspaceAttachment[]; author?: MessageAuthor }
const conflict = () => new HttpError(409, 'This conversation belongs to a different or incomplete first turn.')
const initialContent = (turn: DesktopFirstTurn) => [{ type: 'text' as const, text: turn.message }, ...workspaceAttachmentParts(turn.attachments ?? [])]
function fingerprint(turn: DesktopFirstTurn) {
    return createHash('sha256').update(JSON.stringify([turn.sessionId, initialContent(turn), turn.author?.id ?? null, turn.author?.name ?? null])).digest('hex')
}

// Context enrichment changes the accepted row, but never its visible text, file snapshot or
// author. This also permits conservative read-only reconciliation of old first-turn rows.
function matchesUser(row: { role: unknown; content_json: unknown; author_id: unknown; author_name: unknown }, turn: DesktopFirstTurn) {
    if (row.role !== 'user' || row.author_id !== (turn.author?.id ?? null) || row.author_name !== (turn.author?.name ?? null)) return false
    let content: unknown
    try { content = JSON.parse(String(row.content_json)) } catch { return false }
    if (typeof content === 'string') return content === turn.message && !turn.attachments?.length
    if (!Array.isArray(content)) return false
    const prefix = initialContent(turn)
    return JSON.stringify(content.slice(0, prefix.length)) === JSON.stringify(prefix)
        && content.slice(prefix.length).every(isContextPart)
        && workspaceAttachmentPaths(content).length === (turn.attachments?.length ?? 0)
}

/** An exact replay is read-only; a run ID alone is never proof of delivered user input. */
export async function getDesktopTabRun(agentId: string, turn: DesktopFirstTurn): Promise<boolean> {
    const { client } = await getSystemDb(agentId)
    const [receipts, session, run, first, runs] = await client.batch([
        { sql: 'SELECT * FROM desktop_first_turns WHERE run_id=? OR session_id=?', args: [turn.runId, turn.sessionId] },
        { sql: 'SELECT agent_id FROM sessions WHERE id=?', args: [turn.sessionId] },
        { sql: 'SELECT agent_id,session_id FROM runs WHERE id=?', args: [turn.runId] },
        { sql: "SELECT id,role,content_json,author_id,author_name FROM messages WHERE session_id=? ORDER BY created_at,rowid LIMIT 1", args: [turn.sessionId] },
        { sql: 'SELECT id FROM runs WHERE session_id=? ORDER BY started_at,rowid LIMIT 2', args: [turn.sessionId] },
    ], 'read')
    const receipt = receipts.rows[0]
    const user = first.rows[0]
    if (receipt) {
        if (receipts.rows.length !== 1 || receipt.run_id !== turn.runId || receipt.session_id !== turn.sessionId || receipt.fingerprint !== fingerprint(turn) ||
            session.rows[0]?.agent_id !== agentId || run.rows[0]?.agent_id !== agentId || run.rows[0]?.session_id !== turn.sessionId ||
            !user || receipt.message_id !== user.id || !matchesUser(user, turn)) throw conflict()
        return true
    }
    if (!session.rows.length && !run.rows.length) return false
    // A pre-migration receipt did not bind input. Only a sole run with the matching first user
    // row is unambiguous; a legacy empty/partial conversation is preserved and refused.
    if (session.rows[0]?.agent_id !== agentId || run.rows[0]?.agent_id !== agentId || run.rows[0]?.session_id !== turn.sessionId ||
        runs.rows.length !== 1 || runs.rows[0]?.id !== turn.runId || !user || !matchesUser(user, turn)) throw conflict()
    return true
}

// Session, run, exact input snapshot, FTS and fingerprint commit together, before the HTTP reply
// and before model/tool preparation. A retry returns null and can never append or execute twice.
export async function startDesktopTabRun(agentId: string, turn: DesktopFirstTurn): Promise<MessageRow | null> {
    if (await getDesktopTabRun(agentId, turn)) return null
    const { client } = await getSystemDb(agentId)
    const now = nowIso()
    const user: MessageRow = {
        id: newId(), sessionId: turn.sessionId, role: 'user', contentJson: JSON.stringify(initialContent(turn)),
        toolCallsJson: null, sourcesJson: null, createdAt: now, authorId: turn.author?.id ?? null, authorName: turn.author?.name ?? null,
    }
    try {
        await client.batch([
            { sql: 'INSERT INTO sessions(id,agent_id,created_at,updated_at) VALUES(?,?,?,?)', args: [turn.sessionId, agentId, now, now] },
            { sql: 'INSERT INTO runs(id,agent_id,session_id,started_at) VALUES(?,?,?,?)', args: [turn.runId, agentId, turn.sessionId, now] },
            { sql: "INSERT INTO messages(id,session_id,role,content_json,created_at,author_id,author_name) VALUES(?,?,'user',?,?,?,?)", args: [user.id, turn.sessionId, user.contentJson, now, user.authorId, user.authorName] },
            { sql: 'INSERT INTO messages_fts(content,message_id) VALUES(?,?)', args: [turn.message, user.id] },
            { sql: 'INSERT INTO desktop_first_turns(run_id,session_id,fingerprint,message_id) VALUES(?,?,?,?)', args: [turn.runId, turn.sessionId, fingerprint(turn), user.id] },
        ], 'write')
    } catch (error) {
        // Another same-input request may have won the transaction. A different winner is a
        // conflict, and an actual failed transaction remains a failure rather than a success.
        if (await getDesktopTabRun(agentId, turn)) return null
        throw error
    }
    return user
}
