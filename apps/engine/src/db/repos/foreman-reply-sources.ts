import { createHash } from 'node:crypto'
import type { InStatement } from '@libsql/client'
import { FOREMAN_AGENT_ID, type DesktopForemanChatRef } from '@rerun/contracts'
import type { MessageRow } from '../schema.js'
import { getSystemDb } from '../systemDb.js'

export type ForemanReplyTurn = { runId: string; userMessageId: string }
type ForemanReplyTarget = DesktopForemanChatRef & { sessionId: string; assistantMessageId: string }

const digest = (contentJson: string) => createHash('sha256').update(contentJson).digest('hex')

// Called in the same write batch that saves the assistant message. The already-admitted
// queued turn identifies the user row, including when two turns share a timestamp.
export function foremanReplySourceUpdate(agentId: string, message: MessageRow, turn: ForemanReplyTurn): InStatement {
    return {
        sql: `UPDATE desktop_foreman_reply_sources
              SET assistant_message_id = ?, reply_digest = ?
              WHERE run_id = ? AND user_message_id = ? AND assistant_message_id IS NULL
                AND EXISTS (
                    SELECT 1 FROM runs AS run
                    JOIN desktop_queued_turns AS receipt ON receipt.run_id = run.id
                    JOIN messages AS user_message ON user_message.id = receipt.message_id
                    WHERE run.id = desktop_foreman_reply_sources.run_id AND run.agent_id = ?
                      AND run.session_id = ? AND run.status = 'running'
                      AND user_message.id = desktop_foreman_reply_sources.user_message_id
                      AND user_message.session_id = run.session_id AND user_message.role = 'user'
                )`,
        args: [message.id, digest(message.contentJson), turn.runId, turn.userMessageId, agentId, message.sessionId],
    }
}

export async function readForemanReplySource(target: ForemanReplyTarget) {
    const { client } = await getSystemDb(FOREMAN_AGENT_ID)
    // Read the provenance and transcript in one SQLite snapshot. Match listMessages' order
    // so messages written in the same millisecond have a stable order after a restart.
    const { rows } = await client.execute({
        sql: `SELECT source.run_id, source.user_message_id, source.reply_digest,
                     history.id, history.role, history.content_json, history.tool_calls_json,
                     history.sources_json, history.created_at, history.author_id, history.author_name
              FROM desktop_foreman_reply_sources AS source
              JOIN runs AS run ON run.id = source.run_id
              JOIN desktop_queued_turns AS receipt ON receipt.run_id = run.id AND receipt.message_id = source.user_message_id
              JOIN sessions AS session ON session.id = run.session_id AND session.agent_id = run.agent_id
              JOIN messages AS assistant ON assistant.id = source.assistant_message_id AND assistant.session_id = session.id
              JOIN messages AS user_message ON user_message.id = source.user_message_id AND user_message.session_id = session.id
              JOIN messages AS history ON history.session_id = session.id
              WHERE source.workspace_id = ? AND source.chat_id = ? AND session.id = ? AND assistant.id = ?
                AND run.agent_id = ? AND run.status = 'done' AND run.finished_at IS NOT NULL
                AND session.source = 'dashboard' AND session.status = 'open'
                AND session.origin_agent_id IS NULL AND session.origin_session_id IS NULL
                AND assistant.role = 'assistant' AND user_message.role = 'user'
              ORDER BY history.created_at, history.rowid`,
        args: [target.workspaceId, target.chatId, target.sessionId, target.assistantMessageId, FOREMAN_AGENT_ID],
    })
    const saved = rows[0]
    const reply = rows.find(row => row.id === target.assistantMessageId)
    if (!saved || typeof saved.run_id !== 'string' || typeof saved.user_message_id !== 'string' ||
        typeof reply?.content_json !== 'string' || saved.reply_digest !== digest(reply.content_json)) return null

    // Return only an internal comparison token, never the raw message or tool content.
    const revision = createHash('sha256')
    revision.update(JSON.stringify(['foreman-transcript-v1', target.workspaceId, target.chatId, target.sessionId]))
    for (const row of rows) {
        revision.update(JSON.stringify([row.id, row.role, row.content_json, row.tool_calls_json,
            row.sources_json, row.created_at, row.author_id, row.author_name]))
    }
    return { ...target, sourceRunId: saved.run_id, precedingUserMessageId: saved.user_message_id,
        replyDigest: saved.reply_digest, transcriptRevision: revision.digest('hex') }
}
