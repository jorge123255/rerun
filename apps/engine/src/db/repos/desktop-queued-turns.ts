import { createHash } from 'node:crypto'
import type { DesktopQuestionGuard, DesktopWorkspaceAttachment, MessageAuthor } from '@rerun/contracts'
import { workspaceAttachmentPart } from '@rerun/contracts'
import { getSystemDb } from '../systemDb.js'
import type { MessageRow } from '../schema.js'
import { HttpError } from '../../lib/errors.js'
import { newId, nowIso } from '../../lib/ids.js'

export type QueuedTurn = { runId: string; sessionId: string; message: string; attachmentPath?: string; question?: DesktopQuestionGuard }

function fingerprint(turn: QueuedTurn) {
    const parts: unknown[] = [turn.sessionId, turn.message, turn.attachmentPath ?? null]
    // Old queue receipts keep their original fingerprint. A question answer also binds the
    // immutable source call, so its run ID cannot be replayed for a different question.
    if (turn.question) parts.push([turn.question.sourceMessageId, turn.question.toolCallId, turn.question.fingerprint])
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export async function getDesktopQueuedTurn(agentId: string, turn: QueuedTurn): Promise<boolean> {
    const { client } = await getSystemDb(agentId)
    const result = await client.execute({ sql: 'SELECT fingerprint FROM desktop_queued_turns WHERE run_id = ?', args: [turn.runId] })
    if (!result.rows.length) return false
    if (result.rows[0].fingerprint !== fingerprint(turn)) throw new HttpError(409, 'This queued message ID belongs to a different message or conversation.')
    return true
}

// The receipt, run and user text commit together before an HTTP acknowledgement. Even a crash
// during provider preparation leaves the accepted prompt in history, and retries never resend it.
export async function reserveDesktopQueuedTurn(agentId: string, turn: QueuedTurn, attachment?: DesktopWorkspaceAttachment, author?: MessageAuthor): Promise<MessageRow> {
    const { client } = await getSystemDb(agentId)
    const now = nowIso()
    const user: MessageRow = {
        id: newId(), sessionId: turn.sessionId, role: 'user',
        contentJson: JSON.stringify([{ type: 'text', text: turn.message }, ...(attachment ? [workspaceAttachmentPart(attachment)] : [])]),
        toolCallsJson: null, sourcesJson: null, createdAt: now, authorId: author?.id ?? null, authorName: author?.name ?? null,
    }
    await client.batch([
        { sql: 'INSERT INTO runs (id, agent_id, session_id, started_at) VALUES (?,?,?,?)', args: [turn.runId, agentId, turn.sessionId, now] },
        { sql: 'INSERT INTO messages (id, session_id, role, content_json, created_at, author_id, author_name) VALUES (?,?,?,?,?,?,?)', args: [user.id, turn.sessionId, 'user', user.contentJson, now, user.authorId, user.authorName] },
        { sql: 'INSERT INTO messages_fts(content, message_id) VALUES (?,?)', args: [turn.message, user.id] },
        { sql: 'INSERT INTO desktop_queued_turns (run_id, fingerprint, message_id) VALUES (?,?,?)', args: [turn.runId, fingerprint(turn), user.id] },
    ], 'write')
    return user
}
