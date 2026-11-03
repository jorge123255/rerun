import { and, asc, desc, eq, getTableColumns, gt, gte, isNotNull, sql } from 'drizzle-orm'
import type { ModelMessage } from 'ai'
import { visibleText, type DesktopSourcePart, type MessageAuthor } from '@rerun/contracts'
import { getSystemDb } from '../systemDb.js'
import { messages, type MessageRow } from '../schema.js'
import { newId, nowIso } from '../../lib/ids.js'

// What was said, which is not everything that carries a `text`: a reasoning part does too, and so
// does the context the engine appends to a user turn. It feeds both the search index and the
// `output` of a run.
export function extractText(content: unknown): string {
    return visibleText(content, ' ')
}

// Older conversations can hold a raw string, an untyped {text} envelope or a single AI part.
export function storedContent(json: string): ModelMessage['content'] {
    let content
    try { content = JSON.parse(json) } catch { return json }
    if (typeof content === 'string' || Array.isArray(content)) return content
    if (content && typeof content === 'object') {
        if (typeof content.type === 'string') return [content]
        if (typeof content.text === 'string') return content.text
    }
    return []
}

export async function appendMessage(agentId: string, sessionId: string, message: ModelMessage, author?: MessageAuthor, sources?: DesktopSourcePart[]): Promise<MessageRow> {
    const row: MessageRow = {
        id: newId(),
        sessionId,
        role: message.role,
        contentJson: JSON.stringify(message.content),
        toolCallsJson: null,
        sourcesJson: message.role === 'assistant' && sources?.length ? JSON.stringify(sources) : null,
        createdAt: nowIso(),
        authorId: author?.id ?? null,
        authorName: author?.name ?? null,
    }
    const { db, client } = await getSystemDb(agentId)
    await db.insert(messages).values(row)
    const text = extractText(message.content)
    if (text) await client.execute({ sql: 'INSERT INTO messages_fts(content, message_id) VALUES (?, ?)', args: [text, row.id] })
    return row
}

// The replies the model closed its answer with live beside the row, never in `content_json`: the
// history the model reads back must not show them, the chat and a reload must.
export async function setMessageToolCalls(agentId: string, messageId: string, calls: unknown[]): Promise<void> {
    const { db } = await getSystemDb(agentId)
    await db.update(messages).set({ toolCallsJson: JSON.stringify(calls) }).where(eq(messages.id, messageId))
}

export async function listMessages(agentId: string, sessionId: string, throughMessageId?: string): Promise<MessageRow[]> {
    const { db } = await getSystemDb(agentId)
    const through = throughMessageId === undefined ? undefined
        : sql`(created_at, rowid) <= (SELECT created_at, rowid FROM messages WHERE id = ${throughMessageId} AND session_id = ${sessionId})`
    return db.select().from(messages).where(and(eq(messages.sessionId, sessionId), through)).orderBy(asc(messages.createdAt), asc(sql`rowid`))
}

// Two messages of one turn can share a millisecond, so the insertion order breaks the tie.
export async function lastMessageId(agentId: string, sessionId: string): Promise<string | undefined> {
    const { db } = await getSystemDb(agentId)
    const [row] = await db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, sessionId)).orderBy(desc(messages.createdAt), desc(sql`rowid`)).limit(1)
    return row?.id
}

export async function listSessionAuthorIds(agentId: string, sessionId: string): Promise<string[]> {
    const { db } = await getSystemDb(agentId)
    const rows = await db.selectDistinct({ authorId: messages.authorId }).from(messages).where(and(eq(messages.sessionId, sessionId), isNotNull(messages.authorId)))
    return rows.flatMap(row => (row.authorId ? [row.authorId] : []))
}

export async function listMessagesAfter(agentId: string, sessionId: string, after?: string) {
    const { db } = await getSystemDb(agentId)
    const where = after ? and(eq(messages.sessionId, sessionId), gt(messages.createdAt, after)) : eq(messages.sessionId, sessionId)
    // forkReply dates every copied row before the alternate run. Its own new replies keep using
    // the provider's native history, including when a later turn reopens this conversation.
    const copiedForRegeneration = sql`coalesce(${messages.createdAt} < (
        SELECT runs.started_at FROM desktop_regenerations JOIN runs ON runs.id = desktop_regenerations.run_id
        WHERE desktop_regenerations.session_id = ${sessionId}
    ), 0)`.mapWith(Boolean)
    return db.select({ ...getTableColumns(messages), copiedForRegeneration }).from(messages)
        .where(where).orderBy(asc(messages.createdAt), asc(sql`rowid`))
}

export async function collectAssistantText(agentId: string, sessionId: string, from: string, to: string | null): Promise<string> {
    const { db } = await getSystemDb(agentId)
    const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), gte(messages.createdAt, from)))
        .orderBy(asc(messages.createdAt), asc(sql`rowid`))
    return rows
        .filter(r => r.role === 'assistant' && (!to || r.createdAt <= to))
        .map(r => extractText(storedContent(r.contentJson)))
        .filter(Boolean)
        .join('\n')
}
