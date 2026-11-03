import 'server-only'
import type { Client, Row } from '@libsql/client'
import type { DesktopTabLayout, DesktopTabWrite } from '../session-tabs'
import { DesktopHttpError } from './auth'
import { desktopSessionsQuery, sessionOf } from './store'

type StoredLayout = Pick<DesktopTabWrite, 'tabs' | 'activeIndex'>
function layoutOf(row: Row, sessions: Row[]): DesktopTabLayout {
    const stored: StoredLayout = JSON.parse(String(row.layout))
    const titles = new Map(sessions.map(s => [String(s.id), String(s.title)]))
    const first = new Map(sessions.filter(s => s.first_tab_uid !== null).map(s => [String(s.first_tab_uid), String(s.id)]))
    const active = stored.tabs[stored.activeIndex]
    const resolved = stored.tabs.map(tab => ({ ...tab, id: tab.id ?? first.get(tab.uid) ?? null }))
    const tabs = resolved.flatMap((tab, index) => {
        if (resolved.findIndex(t => t.id === tab.id) !== index) return []
        if (!tab.id) return [{ ...tab, title: 'New conversation' }]
        const title = titles.get(tab.id)
        return title === undefined ? [] : [{ ...tab, title }]
    })
    // Old layouts can outlive a conversation. Keep a usable blank if every saved tab disappeared.
    if (!tabs.length) tabs.push({ uid: active.uid, id: null, title: 'New conversation' })
    const position = tabs.findIndex(tab => tab.uid === active.uid || tab.id === resolved[stored.activeIndex].id)
    const activeIndex = position < 0 ? Math.min(stored.activeIndex, tabs.length - 1) : position
    return { revision: Number(row.revision), tabs, activeIndex }
}

function layoutQuery(agentId: string) {
    return { sql: 'SELECT revision, layout FROM desktop_agent_tabs WHERE agent_id = ?', args: [agentId] }
}

export async function readDesktopChats(db: Client, agentId: string) {
    const [chats, state] = await db.batch([desktopSessionsQuery(agentId), layoutQuery(agentId)], 'read')
    const sessions = chats.rows.map(sessionOf)
    return { sessions, tabs: state.rows[0] ? layoutOf(state.rows[0], chats.rows) : null }
}

export async function writeDesktopTabs(db: Client, agentId: string, input: DesktopTabWrite) {
    const layout = JSON.stringify({ tabs: input.tabs, activeIndex: input.activeIndex } satisfies StoredLayout)
    // Compare and replace in SQLite: delayed writes from a different panel cannot overwrite a newer layout.
    const [, current, chats] = await db.batch([{
        sql: `INSERT INTO desktop_agent_tabs (agent_id, revision, layout)
              SELECT :agent, :base + 1, :layout
              WHERE COALESCE((SELECT revision FROM desktop_agent_tabs WHERE agent_id = :agent), 0) = :base
                AND NOT EXISTS (
                    SELECT 1 FROM json_each(:layout, '$.tabs') AS t WHERE json_extract(t.value, '$.id') IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM desktop_sessions WHERE agent_id = :agent AND id = json_extract(t.value, '$.id'))
                )
              ON CONFLICT(agent_id) DO UPDATE SET revision = excluded.revision, layout = excluded.layout`,
        args: { agent: agentId, base: input.baseRevision, layout },
    }, layoutQuery(agentId), desktopSessionsQuery(agentId)], 'write')
    const sessions = chats.rows.map(sessionOf)
    const owned = new Set(sessions.map(s => s.id))
    if (input.tabs.some(t => t.id !== null && !owned.has(t.id))) throw new DesktopHttpError(404, 'Conversation not found for this coworker')
    const row = current.rows[0]
    const tabs = row ? layoutOf(row, chats.rows) : null
    // A retry with a lost success response can acknowledge the already-stored layout.
    return { tabs, conflict: row?.layout !== layout }
}
