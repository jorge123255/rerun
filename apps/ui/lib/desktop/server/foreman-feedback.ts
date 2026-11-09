import 'server-only'
import type { Client } from '@libsql/client'
import type { MessageFeedbackRating } from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from './auth'

export type DesktopForemanVote = { id: string; messageId: string; rating: MessageFeedbackRating }

const SCHEMA = `CREATE TABLE IF NOT EXISTS desktop_foreman_feedback (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, chat_id, message_id)
)`
const ensured = new WeakSet<Client>()
const chatId = z.string().min(1).max(128)
const workspaceId = z.string().min(1).max(128)
const messageId = z.string().regex(/^engine-[A-Za-z0-9_-]{1,128}$/)

export const desktopForemanFeedbackScopeSchema = z.object({ workspaceId, chatId }).strict()
export const desktopForemanFeedbackRateSchema = desktopForemanFeedbackScopeSchema.extend({ messageId, rating: z.enum(['up', 'down']) }).strict()

export async function ensureDesktopForemanFeedbackSchema(db: Client): Promise<void> {
    if (ensured.has(db)) return
    await db.execute(SCHEMA)
    ensured.add(db)
}

async function requireChat(db: Client, workspace: string, chat: string): Promise<void> {
    const row = await db.execute({
        sql: 'SELECT 1 FROM desktop_foreman_chats WHERE workspace_id = ? AND chat_id = ?',
        args: [workspace, chat],
    })
    if (!row.rows.length) throw new DesktopHttpError(404, 'Foreman conversation not found.')
}

export async function listDesktopForemanFeedback(db: Client, workspace: string, chat: string): Promise<DesktopForemanVote[]> {
    await ensureDesktopForemanFeedbackSchema(db)
    await requireChat(db, workspace, chat)
    const result = await db.execute({
        sql: 'SELECT id, message_id, rating FROM desktop_foreman_feedback WHERE workspace_id = ? AND chat_id = ? ORDER BY updated_at, id',
        args: [workspace, chat],
    })
    return result.rows.map(row => ({ id: String(row.id), messageId: String(row.message_id), rating: String(row.rating) as MessageFeedbackRating }))
}

export async function rateDesktopForemanFeedback(db: Client, input: z.infer<typeof desktopForemanFeedbackRateSchema>): Promise<DesktopForemanVote> {
    await ensureDesktopForemanFeedbackSchema(db)
    await requireChat(db, input.workspaceId, input.chatId)
    // An unchanged rating keeps its vote id so a later undo targets the same row; a changed
    // rating is a new generation, never a silent edit of the earlier one.
    const saved = await db.execute({
        sql: `INSERT INTO desktop_foreman_feedback (id, workspace_id, chat_id, message_id, rating, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(workspace_id, chat_id, message_id) DO UPDATE SET
                id = CASE WHEN rating = excluded.rating THEN id ELSE excluded.id END,
                rating = excluded.rating,
                updated_at = excluded.updated_at
              RETURNING id, message_id, rating`,
        args: [crypto.randomUUID(), input.workspaceId, input.chatId, input.messageId, input.rating, new Date().toISOString()],
    })
    const row = saved.rows[0]
    if (!row) throw new DesktopHttpError(500, 'Could not save your feedback. Try again.')
    return { id: String(row.id), messageId: String(row.message_id), rating: String(row.rating) as MessageFeedbackRating }
}

export async function clearDesktopForemanFeedback(db: Client, workspace: string, chat: string, id: string): Promise<void> {
    await ensureDesktopForemanFeedbackSchema(db)
    await requireChat(db, workspace, chat)
    if (!z.string().uuid().safeParse(id).success) throw new DesktopHttpError(400, 'Invalid feedback')
    const result = await db.execute({
        sql: 'DELETE FROM desktop_foreman_feedback WHERE id = ? AND workspace_id = ? AND chat_id = ?',
        args: [id, workspace, chat],
    })
    if (Number(result.rowsAffected) !== 1) throw new DesktopHttpError(404, 'Feedback not found')
}
