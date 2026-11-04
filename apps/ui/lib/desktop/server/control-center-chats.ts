import 'server-only'
import { sessionsListSchema, type Session } from '@rerun/contracts'
import type { Client, Row } from '@libsql/client'
import { z } from 'zod'
import { request } from '@/lib/engine/client'
import { MAX_REMEMBERED_TABS } from '@/lib/chat/session-tabs'
import { DESKTOP_RECENT_CHAT_LIMIT, type DesktopControlCenterChats, type DesktopOpenChat } from '../control-center-chats'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import { layoutOf } from './session-tabs'
import { desktopSessionsQuery, sessionOf, type DesktopSession } from './store'
import { engineOf } from './settings'
import type { DesktopRuntime } from './runtime'

const RECENT_READ_TIMEOUT_MS = 2_500
const storedLayoutSchema = z.object({
    // Older layouts can contain repeated sessions or a higher tab ceiling. Projection below
    // retains only their genuine, owned targets and never writes a repaired layout.
    tabs: z.array(z.object({ uid: z.string().min(1).max(128), id: z.string().min(1).max(200).nullable() })).min(1).max(128),
    activeIndex: z.number().int().min(0),
}).refine(value => value.activeIndex < value.tabs.length)
    .refine(value => new Set(value.tabs.map(tab => tab.uid)).size === value.tabs.length)

function ownerQuery(agentId: string) {
    return { sql: `SELECT a.id, a.engine_agent_id, a.name, d.completed AS deletion_completed
        FROM desktop_agents a LEFT JOIN desktop_deletions d ON d.agent_id = a.id
        WHERE a.id = ? AND a.workspace_id = 1`, args: [agentId] }
}

function requireOwner(rows: Row[]) {
    const owner = rows[0]
    if (!owner || Number(owner.deletion_completed) === 1) throw new DesktopHttpError(404, 'Coworker not found')
    if (owner.deletion_completed !== null) throw new DesktopHttpError(503, 'This coworker is being removed. Try again once that finishes.')
    return { id: String(owner.id), engineAgentId: String(owner.engine_agent_id), name: String(owner.name) }
}

function openChatsOf(agentId: string, row: Row | undefined, sessions: Row[]): DesktopOpenChat[] {
    if (!row) return []
    let raw: z.infer<typeof storedLayoutSchema>
    try { raw = storedLayoutSchema.parse(JSON.parse(String(row.layout))) }
    catch { throw new DesktopHttpError(503, 'Could not read the saved open chats. Reopen this coworker and try again.') }
    const owned = new Set(sessions.map(session => String(session.id)))
    // layoutOf resolves the first accepted send's stable tab UID and canonical local session.
    // It also manufactures a usable blank for an otherwise empty panel; that fallback is NOT
    // an actually open chat and must never appear as a selectable Control Center result.
    const eligible = new Set(raw.tabs.filter(tab => tab.id === null || owned.has(tab.id)).map(tab => tab.uid))
    const seenUids = new Set<string>(), seenSessions = new Set<string | null>()
    return layoutOf(row, sessions).tabs.flatMap(tab => {
        if (!eligible.has(tab.uid) || seenUids.has(tab.uid) || seenSessions.has(tab.id) || (tab.id !== null && !owned.has(tab.id))) return []
        seenUids.add(tab.uid); seenSessions.add(tab.id)
        return [{ agentId, tabUid: tab.uid, sessionId: tab.id, title: tab.title }]
    })
}

function recentChatsOf(sessions: DesktopSession[], remote: Session[] | null, engineAgentId: string, openChats: DesktopOpenChat[], name: string) {
    if (!remote) return { recentChats: [], recentStatus: 'unavailable' as const, hasMore: false }
    const remoteById = new Map<string, number>(), ambiguous = new Set<string>()
    for (const session of remote) {
        if (session.agentId !== engineAgentId) continue
        const updated = Date.parse(session.updatedAt)
        if (!Number.isFinite(updated)) continue
        if (remoteById.has(session.id) && remoteById.get(session.id) !== updated) ambiguous.add(session.id)
        remoteById.set(session.id, updated)
    }
    // A partial listing cannot establish which conversation was most recently active. Do not
    // quietly substitute local created_at/updated_at, which are not refreshed on every reply.
    if (sessions.some(session => !remoteById.has(session.engineSessionId) || ambiguous.has(session.engineSessionId))) {
        return { recentChats: [], recentStatus: 'unavailable' as const, hasMore: false }
    }
    const openIds = new Set(openChats.flatMap(tab => tab.sessionId === null ? [] : [tab.sessionId]))
    const seen = new Set<string>()
    const recent = sessions.filter(session => {
        if (openIds.has(session.id) || seen.has(session.id)) return false
        seen.add(session.id)
        return true
    }).sort((a, b) => remoteById.get(b.engineSessionId)! - remoteById.get(a.engineSessionId)!
        || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    return {
        recentChats: recent.slice(0, DESKTOP_RECENT_CHAT_LIMIT).map(session => ({ id: session.id, agentId: session.agentId, agentName: name, title: session.title })),
        recentStatus: 'ok' as const,
        hasMore: recent.length > DESKTOP_RECENT_CHAT_LIMIT,
    }
}

export async function readDesktopControlCenterChats(runtime: DesktopRuntime, agentId: string, options: { signal?: AbortSignal } = {}): Promise<DesktopControlCenterChats> {
    const db: Client = await openDesktopDatabase(runtime.dataRoot)
    const owner = requireOwner((await db.execute(ownerQuery(agentId))).rows)
    const deadline = AbortSignal.timeout(RECENT_READ_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    const remote = await request(engineOf(runtime), `/agents/${encodeURIComponent(owner.engineAgentId)}/sessions`,
        { method: 'GET', cache: 'no-store', signal }, value => sessionsListSchema.parse(value).sessions).catch(() => null)

    // The network read may overlap a close, first send, regeneration or coworker deletion.
    // Re-read ownership and the current tab/session mapping together after it, without calling
    // the sessions route's recovery writes or holding a database transaction across the network.
    const [owners, chats, layouts] = await db.batch([
        ownerQuery(agentId), desktopSessionsQuery(agentId),
        { sql: 'SELECT revision, layout FROM desktop_agent_tabs WHERE agent_id = ?', args: [agentId] },
    ], 'read')
    const current = requireOwner(owners.rows)
    if (current.engineAgentId !== owner.engineAgentId) throw new DesktopHttpError(409, 'This coworker changed. Refresh the chats and try again.')
    const sessions = chats.rows.map(sessionOf).filter(session => session.agentId === agentId)
    const openChats = openChatsOf(agentId, layouts.rows[0], chats.rows)
    // Even a legacy layout beyond today's tab ceiling must not reclassify an open saved
    // conversation as recent simply because its tab cannot fit in this bounded response.
    return { agentId, openChats: openChats.slice(0, MAX_REMEMBERED_TABS), ...recentChatsOf(sessions, remote, current.engineAgentId, openChats, current.name) }
}
