import 'server-only'
import { sessionsListSchema, type Session } from '@rerun/contracts'
import type { Client, Row } from '@libsql/client'
import { z } from 'zod'
import { request } from '@/lib/engine/client'
import { MAX_REMEMBERED_TABS } from '@/lib/chat/session-tabs'
import { GENERAL_SESSION_TITLE, generalTabUid } from '../general-threads'
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
    const seenUids = new Set<string>(), seenSessions = new Set<string>()
    return layoutOf(row, sessions).tabs.flatMap(tab => {
        if (!eligible.has(tab.uid) || seenUids.has(tab.uid) || (tab.id !== null && (seenSessions.has(tab.id) || !owned.has(tab.id)))) return []
        seenUids.add(tab.uid)
        if (tab.id !== null) seenSessions.add(tab.id)
        const session = tab.id === null ? undefined : sessions.find(row => String(row.id) === tab.id)
        const firstMessage = session?.first_message == null || session.first_message === '' ? null : String(session.first_message)
        const kind = session && String(session.kind) === 'general' ? 'general' as const : 'thread' as const
        return [{ agentId, tabUid: tab.uid, sessionId: tab.id, title: tab.id === null ? tab.title : String(session?.title ?? tab.title), kind, firstMessage }]
    })
}

function withGeneralChat(agentId: string, openChats: DesktopOpenChat[], sessions: Row[]): DesktopOpenChat[] {
    const uid = generalTabUid(agentId)
    const general = sessions.map(sessionOf).find(session => session.agentId === agentId && session.kind === 'general')
    const pinned: DesktopOpenChat = {
        agentId, tabUid: uid, sessionId: general?.id ?? openChats.find(chat => chat.tabUid === uid)?.sessionId ?? null,
        title: GENERAL_SESSION_TITLE, kind: 'general', firstMessage: null,
    }
    const threads = openChats.filter(chat => chat.tabUid !== uid && chat.kind !== 'general' && chat.sessionId !== general?.id)
    return [pinned, ...threads.slice(0, MAX_REMEMBERED_TABS)]
}

function indexEngineChats(remote: Session[], engineAgentId: string) {
    const remoteById = new Map<string, { updatedAt: number | null; automationTitle: string | null }>()
    for (const session of remote) {
        if (session.agentId !== engineAgentId) continue
        const updated = Date.parse(session.updatedAt)
        if (!Number.isFinite(updated)) continue
        const result = session.source === 'schedule' || session.source === 'trigger' ? session.automationResult : undefined
        const previous = remoteById.get(session.id)
        const updatedAt = previous && previous.updatedAt !== updated ? null : updated
        const title = result?.title ?? null
        const automationTitle = updatedAt === null || (previous && previous.automationTitle !== title) ? null : title
        remoteById.set(session.id, { updatedAt, automationTitle })
    }
    return remoteById
}

function recentChatsOf(sessions: DesktopSession[], remoteById: ReturnType<typeof indexEngineChats> | null, openChats: DesktopOpenChat[], name: string) {
    // A partial listing cannot establish which conversation was most recently active. Do not
    // quietly substitute local created_at/updated_at, which are not refreshed on every reply.
    if (!remoteById || sessions.some(session => remoteById.get(session.engineSessionId)?.updatedAt == null)) {
        return { recentChats: [], recentStatus: 'unavailable' as const, hasMore: false }
    }
    const openIds = new Set(openChats.flatMap(tab => tab.sessionId === null ? [] : [tab.sessionId]))
    const seen = new Set<string>()
    const recent = sessions.filter(session => {
        if (openIds.has(session.id) || seen.has(session.id)) return false
        seen.add(session.id)
        return true
    }).sort((a, b) => remoteById.get(b.engineSessionId)!.updatedAt! - remoteById.get(a.engineSessionId)!.updatedAt!
        || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    return {
        recentChats: recent.slice(0, DESKTOP_RECENT_CHAT_LIMIT).map(session => ({ id: session.id, agentId: session.agentId, agentName: name, title: session.title, kind: session.kind ?? 'thread', firstMessage: session.firstMessage ?? null })),
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
    const remoteById = remote ? indexEngineChats(remote, current.engineAgentId) : null
    const sessions = chats.rows.map(sessionOf).filter(session => session.agentId === agentId)
    const resultTitles = new Map<string, string>()
    for (const session of sessions) {
        const title = remoteById?.get(session.engineSessionId)?.automationTitle
        if (title && session.kind !== 'general') resultTitles.set(session.id, title)
    }
    const applyTitle = <T extends { title: string }>(chat: T, id: string | null): T => {
        const title = id === null ? undefined : resultTitles.get(id)
        return title ? { ...chat, title } : chat
    }
    const openForRecent = layouts.rows[0] ? openChatsOf(agentId, layouts.rows[0], chats.rows) : []
    const openChats = withGeneralChat(agentId, openForRecent, chats.rows)
        .map(chat => applyTitle(chat, chat.sessionId))
    // General stays pinned. Threads beyond the tab ceiling stay out of Recent as well.
    return { agentId, openChats, ...recentChatsOf(sessions.map(chat => applyTitle(chat, chat.id)), remoteById, [...openForRecent, ...openChats], current.name) }
}
