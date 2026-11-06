import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import { foremanBindingSchema, visibleText } from '@rerun/contracts'
import { getRun } from '@/lib/engine/client'
import type { HistoryMessage } from '@/lib/chat/engine-history'
import type { DesktopRuntime } from '../runtime'
import { DesktopHttpError } from '../auth'
import { engineOf } from '../settings'
import { foremanTurn, type ForemanChat } from './chat-store'
import { foremanIntakeMessage } from './intake'
import { readDesktopForemanIntakeReceipt } from './intake-profile'

/** Original Foreman hides its generated kickoff, while retaining every real user message. */
export async function hideDesktopForemanIntakeKickoff(runtime: DesktopRuntime, db: Client, owner: ForemanChat, messages: HistoryMessage[]): Promise<HistoryMessage[]> {
    if (!messages.length || owner.chat.workspaceId !== String(runtime.workspaceId)) return messages
    const row = (await db.execute({
        sql: "SELECT request_id FROM desktop_foreman_intake_completions WHERE workspace_id=? AND chat_id=? AND state IN ('acknowledged','pending','uncertain','failed') ORDER BY CASE state WHEN 'acknowledged' THEN 1 ELSE 0 END DESC,updated_at DESC,rowid DESC LIMIT 1",
        args: [owner.chat.workspaceId, owner.chat.chatId],
    })).rows[0]
    if (!row) return messages
    const receipt = await readDesktopForemanIntakeReceipt(db, owner.chat, String(row.request_id))
    if (!receipt || receipt.state === 'unavailable') return messages
    if (receipt.followUp && (receipt.followUp.runId !== receipt.requestId || receipt.followUp.conversationId !== owner.sessionId)) return messages
    const turn = await foremanTurn(db, receipt.requestId)
    if (!turn || !['pending', 'failed', 'admitted', 'finished'].includes(turn.status)) return messages
    const binding = foremanBindingSchema.safeParse(turn.body.binding)
    const text = foremanIntakeMessage(receipt.answers)
    if (!messages.some(message => message.role === 'user' && visibleText(message.parts, '') === text)) return messages
    const fingerprint = createHash('sha256').update(JSON.stringify([owner.chat, text, null])).digest('hex')
    const indexed = (await db.execute({ sql: 'SELECT chat_id FROM desktop_foreman_turns WHERE request_id=?', args: [receipt.requestId] })).rows[0]
    if (!binding.success || String(indexed?.chat_id) !== owner.chat.chatId || turn.fingerprint !== fingerprint
        || binding.data.workspaceId !== owner.chat.workspaceId || binding.data.chatId !== owner.chat.chatId || binding.data.runId !== receipt.requestId
        || turn.body.sessionId !== owner.sessionId || turn.body.text !== text) return messages

    // Presentation does not require completion ACK: a successful pending poll must not cache
    // the raw kickoff behind the card and expose it when that card closes. This grants no phase
    // or completion authority. The engine's atomic admission supplies the exact user identity;
    // matching text, position or a marker alone can never hide an ordinary pasted message.
    const run = await getRun(engineOf(runtime), 'foreman', receipt.requestId, { signal: AbortSignal.timeout(3_000) }).catch(() => null)
    if (!run || run.agentId !== 'foreman' || run.id !== receipt.requestId || run.sessionId !== owner.sessionId
        || !run.queuedUserMessageId || run.model && run.model !== binding.data.model.model
        || !messages.some(message => message.id === `engine-${run.queuedUserMessageId}`)) {
        // Do not publish a stale raw kickoff when its read-only identity proof is unavailable.
        // A later successful poll recovers the conversation without resending the intake.
        throw new DesktopHttpError(503, 'The Foreman conversation could not be loaded. Please retry.')
    }
    return messages.filter(message => !(message.role === 'user' && message.id === `engine-${run.queuedUserMessageId}` && visibleText(message.parts, '') === text))
}
