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
    const { rows } = await client.execute({
        sql: `SELECT source.run_id,source.user_message_id,source.reply_digest,assistant.content_json
              FROM desktop_foreman_reply_sources AS source
              JOIN runs AS run ON run.id = source.run_id
              JOIN desktop_queued_turns AS receipt ON receipt.run_id = run.id AND receipt.message_id = source.user_message_id
              JOIN sessions AS session ON session.id = run.session_id AND session.agent_id = run.agent_id
              JOIN messages AS assistant ON assistant.id = source.assistant_message_id AND assistant.session_id = session.id
              JOIN messages AS user_message ON user_message.id = source.user_message_id AND user_message.session_id = session.id
              WHERE source.workspace_id = ? AND source.chat_id = ? AND session.id = ? AND assistant.id = ?
                AND run.agent_id = ? AND run.status = 'done' AND run.finished_at IS NOT NULL
                AND session.source = 'dashboard' AND session.status = 'open'
                AND session.origin_agent_id IS NULL AND session.origin_session_id IS NULL
                AND assistant.role = 'assistant' AND user_message.role = 'user'`,
        args: [target.workspaceId, target.chatId, target.sessionId, target.assistantMessageId, FOREMAN_AGENT_ID],
    })
    const saved = rows[0]
    if (!saved || typeof saved.run_id !== 'string' || typeof saved.user_message_id !== 'string' ||
        typeof saved.content_json !== 'string' || saved.reply_digest !== digest(saved.content_json)) return null
    return { ...target, sourceRunId: saved.run_id, precedingUserMessageId: saved.user_message_id, replyDigest: saved.reply_digest }
}
