import 'server-only'
import type { Client } from '@libsql/client'
import { MESSAGE_FEEDBACK_CATEGORY_VALUES, type MessageFeedbackRating } from '@rerun/contracts'
import { z } from 'zod'
import { transformEngineMessages } from '@/lib/chat/engine-history'
import { getSessionMessages } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession } from './store'

const messageIdSchema = z.string().regex(/^engine-[A-Za-z0-9_-]{1,128}$/)

export const desktopReplyRateSchema = z.object({
    agentId: z.string().uuid(),
    messageId: messageIdSchema,
    rating: z.enum(['up', 'down']),
})

export const desktopReplyDetailsSchema = z.object({
    agentId: z.string().uuid(),
    id: z.string().uuid(),
    category: z.enum(MESSAGE_FEEDBACK_CATEGORY_VALUES).nullable(),
    details: z.string().trim().max(5_000),
})

const SAVE_FAILED = 'Could not save your feedback. Try again.'

export type DesktopReplyVote = { id: string; messageId: string; rating: MessageFeedbackRating }

async function ownedConversation(db: Client, agentId: string, sessionId: string) {
    if (!z.string().uuid().safeParse(sessionId).success) throw new DesktopHttpError(404, 'Conversation not found')
    const session = await findDesktopSession(db, sessionId)
    if (!session || session.agentId !== agentId) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return { session, agent }
}

// The id has to be an assistant row already saved for this coworker and conversation.
// A local read is the check. It does not start a model turn.
async function requireSavedAssistant(runtime: DesktopRuntime, agent: { engineAgentId: string }, session: { engineSessionId: string }, messageId: string) {
    let history
    try {
        const messages = await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId, { requireSuccess: true })
        history = transformEngineMessages(messages, { desktopSummaries: true })
    } catch {
        throw new DesktopHttpError(502, SAVE_FAILED)
    }
    const message = history.find(item => item.id === messageId && item.role === 'assistant')
    const text = message?.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('') ?? ''
    if (!message || !text) throw new DesktopHttpError(404, 'Message not found')
}

export async function listDesktopReplyFeedback(db: Client, agentId: string, sessionId: string): Promise<DesktopReplyVote[]> {
    const { session } = await ownedConversation(db, agentId, sessionId)
    const result = await db.execute({
        sql: 'SELECT id, message_id, rating FROM desktop_message_feedback WHERE session_id = ? AND agent_id = ? ORDER BY updated_at, id',
        args: [session.id, agentId],
    })
    return result.rows.map(row => ({ id: String(row.id), messageId: String(row.message_id), rating: String(row.rating) as MessageFeedbackRating }))
}

export async function rateDesktopReply(db: Client, runtime: DesktopRuntime, sessionId: string, input: z.infer<typeof desktopReplyRateSchema>): Promise<DesktopReplyVote> {
    const { session, agent } = await ownedConversation(db, input.agentId, sessionId)
    await requireSavedAssistant(runtime, agent, session, input.messageId)
    const now = new Date().toISOString()
    await db.execute({
        sql: `INSERT INTO desktop_message_feedback (id, agent_id, session_id, message_id, rating, category, details, updated_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
              ON CONFLICT(session_id, message_id) DO UPDATE SET
                rating = excluded.rating,
                category = NULL,
                details = NULL,
                updated_at = excluded.updated_at`,
        args: [crypto.randomUUID(), agent.id, session.id, input.messageId, input.rating, now],
    })
    const saved = await db.execute({
        sql: 'SELECT id, message_id, rating, category, details FROM desktop_message_feedback WHERE session_id = ? AND message_id = ?',
        args: [session.id, input.messageId],
    })
    const row = saved.rows[0]
    if (!row || row.category !== null || row.details !== null) throw new DesktopHttpError(500, SAVE_FAILED)
    return { id: String(row.id), messageId: String(row.message_id), rating: String(row.rating) as MessageFeedbackRating }
}

export async function updateDesktopReplyDetails(db: Client, runtime: DesktopRuntime, sessionId: string, input: z.infer<typeof desktopReplyDetailsSchema>): Promise<void> {
    const { session, agent } = await ownedConversation(db, input.agentId, sessionId)
    const existing = await db.execute({
        sql: 'SELECT message_id FROM desktop_message_feedback WHERE id = ? AND session_id = ? AND agent_id = ?',
        args: [input.id, session.id, agent.id],
    })
    const messageId = existing.rows[0]?.message_id
    if (typeof messageId !== 'string') throw new DesktopHttpError(404, 'Feedback not found')
    await requireSavedAssistant(runtime, agent, session, messageId)
    const details = input.details || null
    const result = await db.execute({
        sql: `UPDATE desktop_message_feedback SET category = ?, details = ?, updated_at = ?
              WHERE id = ? AND session_id = ? AND agent_id = ?`,
        args: [input.category, details, new Date().toISOString(), input.id, session.id, agent.id],
    })
    if (Number(result.rowsAffected) !== 1) throw new DesktopHttpError(404, 'Feedback not found')
}

export async function clearDesktopReplyFeedback(db: Client, agentId: string, sessionId: string, feedbackId: string): Promise<void> {
    if (!z.string().uuid().safeParse(feedbackId).success) throw new DesktopHttpError(400, 'Invalid feedback')
    const { session, agent } = await ownedConversation(db, agentId, sessionId)
    const result = await db.execute({
        sql: 'DELETE FROM desktop_message_feedback WHERE id = ? AND session_id = ? AND agent_id = ?',
        args: [feedbackId, session.id, agent.id],
    })
    if (Number(result.rowsAffected) !== 1) throw new DesktopHttpError(404, 'Feedback not found')
}
