import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import type { DesktopForemanChatRef, DesktopForemanModelRef, ForemanBrief } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'

export const DESKTOP_FOREMAN_CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_foreman_chats(
 chat_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE,
 engine_session_id TEXT NOT NULL UNIQUE, model TEXT, ui TEXT, ui_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS desktop_foreman_turns(
 request_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES desktop_foreman_chats(chat_id),
 fingerprint TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, error TEXT
);
CREATE INDEX IF NOT EXISTS desktop_foreman_turns_chat ON desktop_foreman_turns(chat_id,created_at);
`
export type ForemanChat = { chat: DesktopForemanChatRef; sessionId: string; model: DesktopForemanModelRef | null }
export type ForemanTurn = {
    binding: DesktopForemanChatRef & { runId: string; model: DesktopForemanModelRef }
    sessionId: string
    text: string
    brief: ForemanBrief
}
const LOCKS = Symbol.for('rerun.desktop.foreman.chat-locks.v1')
const locks = () => ((globalThis as unknown as Record<symbol, WeakMap<Client, Promise<unknown>>>)[LOCKS] ??= new WeakMap())
export function withForemanChatWrite<T>(db: Client, work: () => Promise<T>): Promise<T> {
    const result = (locks().get(db) ?? Promise.resolve()).catch(() => {}).then(work)
    locks().set(db, result)
    void result.then(() => { if (locks().get(db) === result) locks().delete(db) }, () => { if (locks().get(db) === result) locks().delete(db) })
    return result
}
export async function ensureForemanChat(db: Client, workspaceId: string): Promise<ForemanChat> {
    await db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id) VALUES(?,?,?) ON CONFLICT(workspace_id) DO NOTHING', args: [`fmc_${randomUUID()}`, workspaceId, randomUUID()] })
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_foreman_chats WHERE workspace_id=?', args: [workspaceId] })).rows[0]!
    return { chat: { workspaceId, chatId: String(row.chat_id) }, sessionId: String(row.engine_session_id), model: row.model ? JSON.parse(String(row.model)) : null }
}
export async function ownedForemanChat(db: Client, chat: DesktopForemanChatRef): Promise<ForemanChat> {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_foreman_chats WHERE workspace_id=? AND chat_id=?', args: [chat.workspaceId, chat.chatId] })).rows[0]
    if (!row) throw new DesktopHttpError(404, 'Foreman conversation not found.')
    return { chat, sessionId: String(row.engine_session_id), model: row.model ? JSON.parse(String(row.model)) : null }
}
export async function foremanTurn(db: Client, id: string) {
    const row = (await db.execute({ sql: 'SELECT * FROM desktop_foreman_turns WHERE request_id=?', args: [id] })).rows[0]
    return row ? { body: JSON.parse(String(row.body)) as ForemanTurn, fingerprint: String(row.fingerprint), status: String(row.status), error: row.error ? String(row.error) : null } : null
}
