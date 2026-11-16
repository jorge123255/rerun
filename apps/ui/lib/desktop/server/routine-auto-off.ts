import 'server-only'
import type { Client } from '@libsql/client'
import type { Locale } from '@rerun/i18n'
import { z } from 'zod'
import { desktopRoutineAutoOffNotice } from '@/lib/desktop/i18n/routine-messages'
import type { NotificationPayload } from '@/lib/engine/types'
import type { DesktopAttentionItem } from '../attention'
import type { DesktopNotificationEvent } from '../notifications'
import { openDesktopDatabase } from './database'
import { withRosterWrite } from './roster-writes'
import type { DesktopRuntime } from './runtime'
import { adoptDesktopScheduleEvent } from './schedules/adoption'
import { engineOf } from './settings'

// A routine switched off after ten failed runs in a row tells the person once, in a notification
// of its own (decided November 16, 2026). It used to ride the failed run's notification, which a
// muted coworker hides. This is the one event that passes the per-coworker notification rule: the
// notifications reader lists it without asking that rule, and it sits in the inbox until it is
// marked as read. Every other notification is filtered exactly as before.

const PREFIX = 'routine-off:'
const noticeSchema = z.object({
    routineAutoOff: z.literal(true),
    scheduleSlug: z.string().min(1).max(160),
    sourceName: z.string().min(1).max(400),
    disabledAt: z.string().min(1).max(64).refine(value => Number.isFinite(Date.parse(value))),
})

/** True for the engine's switch-off notice, whatever becomes of it: no other handler should take it. */
export function isDesktopRoutineAutoOffNotice(payload: NotificationPayload): boolean {
    return payload.event === 'agent.notification' && payload.metadata?.routineAutoOff === true
}

/**
 * Keeps the engine's notice, once per switch-off. The conversation it opens is the failed run's,
 * or the one the engine made to hold the notice when no run ever started; either is adopted here.
 */
export async function recordDesktopRoutineAutoOff(runtime: DesktopRuntime, payload: NotificationPayload): Promise<boolean> {
    const notice = noticeSchema.safeParse(payload.metadata)
    if (!isDesktopRoutineAutoOffNotice(payload) || !notice.success || !payload.sessionId) return false
    const engineSessionId = payload.sessionId
    const db = await openDesktopDatabase(runtime.dataRoot)
    // Verifies with the engine that this is that coworker's own scheduled conversation.
    if (!await adoptDesktopScheduleEvent(db, engineOf(runtime), { agentId: payload.agentId, sessionId: engineSessionId, runId: null })) return false
    return withRosterWrite(async () => {
        const owner = (await db.execute({
            sql: `SELECT a.id AS agent_id, s.id AS session_id FROM desktop_agents a
                  JOIN desktop_sessions s ON s.agent_id = a.id AND s.engine_session_id = ?
                  LEFT JOIN desktop_deletions d ON d.agent_id = a.id
                  WHERE a.engine_agent_id = ? AND a.workspace_id = 1 AND d.agent_id IS NULL`,
            args: [engineSessionId, payload.agentId],
        })).rows
        if (owner.length !== 1) return false
        const name = notice.data.sourceName.replace(/\s+/g, ' ').trim().slice(0, 200) || notice.data.scheduleSlug
        const result = await db.execute({
            sql: `INSERT INTO desktop_routine_auto_off_notices
                  (id, workspace_id, agent_engine_id, agent_local_id, session_engine_id, session_local_id, slug, routine_name, disabled_at, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_engine_id, slug, disabled_at) DO NOTHING`,
            args: [crypto.randomUUID(), runtime.workspaceId, payload.agentId, String(owner[0].agent_id), engineSessionId, String(owner[0].session_id),
                notice.data.scheduleSlug, name, new Date(Date.parse(notice.data.disabledAt)).toISOString(), new Date().toISOString()],
        })
        return Number(result.rowsAffected) === 1
    })
}

type Notice = { id: string; agentId: string; agentName: string; agentEnabled: boolean; sessionId: string; title: string; updatedAt: string; routine: string; disabledAt: string }

// Only a notice whose coworker and conversation are still the recorded ones is ever shown or opened.
async function liveNotices(db: Client, where: string, args: (string | number)[]): Promise<Notice[]> {
    const rows = (await db.execute({
        sql: `SELECT n.id, n.routine_name, n.disabled_at, a.id AS agent_id, a.name AS agent_name, a.enabled AS enabled, s.id AS session_id, s.title AS title, s.updated_at AS updated_at
              FROM desktop_routine_auto_off_notices n
              JOIN desktop_agents a ON a.id = n.agent_local_id AND a.engine_agent_id = n.agent_engine_id AND a.workspace_id = 1
              JOIN desktop_sessions s ON s.id = n.session_local_id AND s.agent_id = a.id AND s.engine_session_id = n.session_engine_id
              LEFT JOIN desktop_deletions d ON d.agent_id = a.id
              WHERE d.agent_id IS NULL AND ${where}
              ORDER BY n.disabled_at DESC LIMIT 100`,
        args,
    })).rows
    return rows.map(row => ({
        id: `${PREFIX}${String(row.id)}`, agentId: String(row.agent_id), agentName: String(row.agent_name), agentEnabled: Number(row.enabled) !== 0,
        sessionId: String(row.session_id), title: String(row.title), updatedAt: String(row.updated_at), routine: String(row.routine_name), disabledAt: String(row.disabled_at),
    }))
}

const ownId = (id: string) => id.startsWith(PREFIX) && /^[A-Za-z0-9-]{8,64}$/.test(id.slice(PREFIX.length)) ? id.slice(PREFIX.length) : null

/**
 * The notification of each switch-off not announced yet. The caller applies the workspace-wide
 * switches (notifications off altogether, the install cutoff, what was already shown) and
 * deliberately does not ask the coworker's own rule.
 */
export async function readDesktopRoutineAutoOffEvents(db: Client, locale: Locale): Promise<{ at: number; event: DesktopNotificationEvent }[]> {
    return (await liveNotices(db, '1 = 1', [])).map(notice => ({
        at: Date.parse(notice.disabledAt),
        event: {
            key: notice.id, kind: 'error' as const, source: 'schedule' as const, agentId: notice.agentId, agentName: notice.agentName, sessionId: notice.sessionId,
            title: notice.agentName, subtitle: notice.routine.slice(0, 200), body: desktopRoutineAutoOffNotice(locale, notice.routine, notice.agentName).slice(0, 400),
            silent: false, terminalId: notice.id,
        },
    }))
}

/** The inbox item of each switch-off the person has not marked as read. */
export async function readDesktopRoutineAutoOffAttention(db: Client, runtime: DesktopRuntime, locale: Locale): Promise<DesktopAttentionItem[]> {
    return (await liveNotices(db, 'n.workspace_id = ? AND n.acknowledged_at IS NULL', [runtime.workspaceId])).map(notice => ({
        id: notice.id, kind: 'info' as const, agentId: notice.agentId, agentName: notice.agentName, agentEnabled: notice.agentEnabled, sessionId: notice.sessionId,
        title: notice.title, summary: desktopRoutineAutoOffNotice(locale, notice.routine, notice.agentName).replace(/\s+/g, ' ').trim().slice(0, 280),
        requestedAt: notice.disabledAt, updatedAt: notice.updatedAt,
    }))
}

/** « Mark as read »: only the exact notice, for the coworker and conversation it still belongs to. */
export async function acknowledgeDesktopRoutineAutoOff(db: Client, runtime: DesktopRuntime, item: { id: string; agentId: string; sessionId: string }): Promise<boolean> {
    const id = ownId(item.id)
    if (!id) return false
    return withRosterWrite(async () => {
        const current = (await liveNotices(db, 'n.id = ? AND n.workspace_id = ? AND n.acknowledged_at IS NULL', [id, runtime.workspaceId]))[0]
        if (!current || current.agentId !== item.agentId || current.sessionId !== item.sessionId) return false
        const updated = await db.execute({ sql: 'UPDATE desktop_routine_auto_off_notices SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL', args: [new Date().toISOString(), id] })
        return Number(updated.rowsAffected) === 1
    })
}

/** Where a click on the notification lands: the notice's own conversation, or nowhere. */
export async function readDesktopRoutineAutoOffBinding(db: Client, key: string): Promise<{ agentId: string; sessionId: string } | null> {
    const id = ownId(key)
    if (!id) return null
    const notice = (await liveNotices(db, 'n.id = ?', [id]))[0]
    return notice ? { agentId: notice.agentId, sessionId: notice.sessionId } : null
}
