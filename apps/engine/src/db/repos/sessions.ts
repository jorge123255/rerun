import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import { parseScheduledRun, type SessionSource } from '@rerun/contracts'
import { getSystemDb } from '../systemDb.js'
import { sessions, type SessionRow } from '../schema.js'
import { newId, nowIso } from '../../lib/ids.js'
import { extractText, storedContent } from './messages.js'
import { desktopAutomationResultJson, ensureDesktopAutomationResults, parseStoredDesktopAutomationResult } from '../desktop-automation-results.js'

export type SessionOrigin = { originAgentId: string; originSessionId: string }

export async function createSession(agentId: string, title = 'Untitled', origin?: SessionOrigin, source: SessionSource = 'dashboard'): Promise<SessionRow> {
    const now = nowIso()
    const row: SessionRow = {
        id: newId(),
        agentId,
        title,
        status: 'open',
        source,
        originAgentId: origin?.originAgentId ?? null,
        originSessionId: origin?.originSessionId ?? null,
        createdAt: now,
        updatedAt: now,
    }
    const { db } = await getSystemDb(agentId)
    await db.insert(sessions).values(row)
    return row
}

export async function getSession(agentId: string, id: string): Promise<SessionRow | undefined> {
    const { db } = await getSystemDb(agentId)
    const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
    return rows[0]
}

export async function listSessions(agentId: string, includeDesktopResults = false) {
    const { client, db } = await getSystemDb(agentId)
    if (!includeDesktopResults) return db.select().from(sessions).where(eq(sessions.agentId, agentId)).orderBy(desc(sessions.updatedAt))
    await ensureDesktopAutomationResults(client)
    const rows = await db.select({ ...getTableColumns(sessions), resultJson: desktopAutomationResultJson })
        .from(sessions).where(eq(sessions.agentId, agentId)).orderBy(desc(sessions.updatedAt))
    return rows.map(({ resultJson, ...row }) => {
        const automationResult = parseStoredDesktopAutomationResult(resultJson)
        return { ...row, ...(automationResult && { automationResult }) }
    })
}

// Like the upstream General feed, fetch metadata for the newest 200 branches in one read.
export async function listDesktopThreadMetadata(agentId: string) {
    const { client, db } = await getSystemDb(agentId)
    await ensureDesktopAutomationResults(client)
    const rows = await db.select({
        id: sessions.id,
        source: sessions.source,
        originAgentId: sessions.originAgentId,
        title: sessions.title,
        resultJson: desktopAutomationResultJson,
        runStatus: sql<string | null>`(SELECT r.status FROM runs r WHERE r.session_id = sessions.id
            AND r.agent_id = sessions.agent_id ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1)`,
        scheduledMessage: sql<string | null>`CASE WHEN sessions.source = 'schedule' THEN (
            SELECT CASE WHEN length(m.content_json) <= 262144 THEN m.content_json END
            FROM messages m WHERE m.session_id = sessions.id AND m.role = 'user'
            ORDER BY m.rowid LIMIT 1) END`,
    }).from(sessions).where(eq(sessions.agentId, agentId))
        .orderBy(desc(sessions.createdAt), sql`sessions.rowid DESC`).limit(200)
    return rows.map(({ title, scheduledMessage, resultJson, ...thread }) => {
        const schedule = scheduledMessage ? parseScheduledRun(extractText(storedContent(scheduledMessage))) : null
        const automationName = thread.source === 'schedule' ? schedule?.name ?? (title.replace(/^schedule: /, '') || null)
            : thread.source === 'trigger' ? title.replace(/^trigger: /, '') || null : null
        const automationResult = parseStoredDesktopAutomationResult(resultJson)
        return { ...thread, automationName, ...(automationResult && { automationResult }) }
    })
}

export async function touchSession(agentId: string, id: string, title?: string): Promise<void> {
    const patch: Partial<SessionRow> = { updatedAt: nowIso() }
    if (title) patch.title = title
    const { db } = await getSystemDb(agentId)
    await db.update(sessions).set(patch).where(eq(sessions.id, id))
}

export async function sessionBelongsToAgent(id: string, agentId: string): Promise<boolean> {
    const { db } = await getSystemDb(agentId)
    const rows = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, id), eq(sessions.agentId, agentId))).limit(1)
    return rows.length > 0
}
