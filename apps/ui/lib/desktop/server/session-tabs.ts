import 'server-only'
import type { Client, Row } from '@libsql/client'
import { desktopAttachmentPathsSchema, desktopAttachmentItemsSchema, desktopAttachmentSelectionsOf, desktopAttachmentFieldsOf, type DesktopAttachmentSelection } from '@rerun/contracts'
import type { DesktopTabLayout, DesktopTabWrite } from '../session-tabs'
import { DesktopHttpError } from './auth'
import { desktopSessionsQuery, sessionOf } from './store'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { withRosterWrite } from './roster-writes'
import { assertDesktopCreationSettled } from './creation-guard'

type StoredLayout = Pick<DesktopTabWrite, 'tabs' | 'activeIndex'>
export function layoutOf(row: Row, sessions: Row[]): DesktopTabLayout {
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

function draftAttachmentPaths(row: Row): DesktopAttachmentSelection[] {
    if (row.attachment_items !== null && row.attachment_items !== undefined) {
        return desktopAttachmentSelectionsOf({ attachmentItems: desktopAttachmentItemsSchema.parse(JSON.parse(String(row.attachment_items))) })
    }
    if (row.attachment_paths !== null && row.attachment_paths !== undefined) {
        try {
            const parsed = desktopAttachmentPathsSchema.safeParse(JSON.parse(String(row.attachment_paths)))
            if (parsed.success) return parsed.data
        } catch { /* Read legacy drafts the same way as the composer draft endpoint. */ }
    }
    return row.attachment_path !== null && row.attachment_path !== undefined ? [String(row.attachment_path)] : []
}

export async function readDesktopChats(db: Client, agentId: string) {
    const [chats, state] = await db.batch([desktopSessionsQuery(agentId), layoutQuery(agentId)], 'read')
    const sessions = chats.rows.map(sessionOf)
    return { sessions, tabs: state.rows[0] ? layoutOf(state.rows[0], chats.rows) : null }
}

export function writeDesktopTabs(db: Client, agentId: string, input: DesktopTabWrite) {
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(db, agentId)
        await assertDesktopCreationSettled(db, agentId)
        const layout = JSON.stringify({ tabs: input.tabs, activeIndex: input.activeIndex } satisfies StoredLayout)
        const transaction = await db.transaction('write')
        try {
            const current = await transaction.execute(layoutQuery(agentId))
            const chats = await transaction.execute(desktopSessionsQuery(agentId))
            const owned = new Set(chats.rows.map(row => String(row.id)))
            if (input.tabs.some(t => t.id !== null && !owned.has(t.id))) throw new DesktopHttpError(404, 'Conversation not found for this coworker')
            const row = current.rows[0]
            // Lost-response retries acknowledge the stored layout without repeating a fork
            // transfer or clearing the alternate's newer draft a second time.
            if (Number(row?.revision ?? 0) !== input.baseRevision) {
                await transaction.commit()
                return { tabs: row ? layoutOf(row, chats.rows) : null, conflict: row?.layout !== layout }
            }
            const old: StoredLayout = row ? JSON.parse(String(row.layout)) : { tabs: [], activeIndex: 0 }
            const first = new Map(chats.rows.filter(s => s.first_tab_uid !== null).map(s => [String(s.first_tab_uid), String(s.id)]))
            const previous = old.tabs.map(tab => ({ ...tab, id: tab.id ?? first.get(tab.uid) ?? null }))
            // Plan warning ownership from the original snapshot. Updating by UID while
            // walking tabs would move the same records twice during a swap or cycle.
            const originalTabs = new Map(previous.map(tab => [tab.uid, tab]))
            const storedUploads = await transaction.execute({ sql: 'SELECT id,tab_uid FROM desktop_composer_uploads WHERE agent_id=?', args: [agentId] })
            const uploadMoves = storedUploads.rows.map(upload => {
                const from = String(upload.tab_uid), before = originalTabs.get(from)
                const to = !before ? null : before.id === null
                    ? input.tabs.find(tab => tab.uid === from)?.uid ?? null
                    : input.tabs.find(tab => tab.id === before.id)?.uid ?? null
                return { id: String(upload.id), from, to }
            })
            const finalCounts = new Map<string, number>()
            for (const { to } of uploadMoves) {
                if (to === null) continue
                const count = (finalCounts.get(to) ?? 0) + 1
                if (count > 10) throw new DesktopHttpError(409, 'Check unresolved imports before combining these conversation tabs.')
                finalCounts.set(to, count)
            }
            const storedDrafts = await transaction.execute({ sql: 'SELECT tab_uid, revision, text, attachment_path, attachment_paths, attachment_items FROM desktop_composer_drafts WHERE agent_id = ?', args: [agentId] })
            const drafts = new Map(storedDrafts.rows.map(draft => [String(draft.tab_uid), draft]))
            const transfers = new Map<string, Row>()
            const clear = new Set<string>()
            const writeDraft = async (uid: string, prior: Row | undefined, text: string, attachments: readonly DesktopAttachmentSelection[]) => {
                const version = Number(prior?.revision ?? 0)
                if (version >= Number.MAX_SAFE_INTEGER - 1) throw new DesktopHttpError(409, 'This draft version cannot be moved. Open a new conversation tab.')
                const fields = desktopAttachmentFieldsOf(attachments)
                await transaction.execute({ sql: `INSERT INTO desktop_composer_drafts (agent_id,tab_uid,revision,text,attachment_path,attachment_paths,attachment_items,updated_at) VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(agent_id,tab_uid) DO UPDATE SET revision=excluded.revision,text=excluded.text,attachment_path=excluded.attachment_path,attachment_paths=excluded.attachment_paths,attachment_items=excluded.attachment_items,updated_at=excluded.updated_at`,
                    args: [agentId, uid, version + 1, text, typeof attachments[0] === 'string' ? attachments[0] : null, fields.attachmentPaths ? JSON.stringify(fields.attachmentPaths) : null, fields.attachmentItems ? JSON.stringify(fields.attachmentItems) : null, new Date().toISOString()] })
            }
            for (const before of previous) {
                const after = input.tabs.find(tab => tab.uid === before.uid)
                if (before.id === null || after?.id === before.id) continue
                const source = drafts.get(before.uid)
                const destination = input.tabs.find(tab => tab.id === before.id && tab.uid !== before.uid)
                if (destination && source && (source.text !== '' || draftAttachmentPaths(source).length > 0)) {
                    const existing = drafts.get(destination.uid)
                    if (existing && (existing.text !== '' || draftAttachmentPaths(existing).length > 0) &&
                        (existing.text !== source.text || JSON.stringify(draftAttachmentPaths(existing)) !== JSON.stringify(draftAttachmentPaths(source)))) throw new DesktopHttpError(409, 'Both conversation tabs have drafts. Reload the tabs before moving them.')
                    transfers.set(destination.uid, source)
                }
                // A regenerated reply keeps the live UID. Its old draft belongs to the original
                // chat's new UID; a versioned empty row rejects autosaves still in flight there.
                if (after) clear.add(before.uid)
            }
            for (const uid of clear) if (!transfers.has(uid)) await writeDraft(uid, drafts.get(uid), '', [])
            for (const [uid, source] of transfers) await writeDraft(uid, drafts.get(uid), String(source.text), draftAttachmentPaths(source))
            for (const { id, from, to } of uploadMoves) {
                if (to === from) continue
                if (to === null) {
                    // A removed chat's warning must not attach to a new chat reusing its UID.
                    await transaction.execute({ sql: 'DELETE FROM desktop_composer_uploads WHERE id=? AND agent_id=? AND tab_uid=?', args: [id, agentId, from] })
                } else {
                    await transaction.execute({ sql: 'UPDATE desktop_composer_uploads SET tab_uid=? WHERE id=? AND agent_id=? AND tab_uid=?', args: [to, id, agentId, from] })
                }
            }
            await transaction.execute({ sql: `INSERT INTO desktop_agent_tabs (agent_id,revision,layout) VALUES (?,?,?)
                ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision,layout=excluded.layout`, args: [agentId, input.baseRevision + 1, layout] })
            // Closing a tab discards only that tab's ordinary draft and its bounded retry receipts.
            await transaction.execute({ sql: `DELETE FROM desktop_composer_drafts WHERE agent_id = ? AND tab_uid NOT IN
                (SELECT json_extract(value, '$.uid') FROM json_each(?, '$.tabs'))`, args: [agentId, layout] })
            await transaction.execute({ sql: `DELETE FROM desktop_composer_uploads WHERE agent_id = ? AND tab_uid NOT IN
                (SELECT json_extract(value, '$.uid') FROM json_each(?, '$.tabs'))`, args: [agentId, layout] })
            const saved = (await transaction.execute(layoutQuery(agentId))).rows[0]
            await transaction.commit()
            return { tabs: layoutOf(saved, chats.rows), conflict: false }
        } finally { transaction.close() }
    })
}
