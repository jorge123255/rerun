import 'server-only'
import type { Client } from '@libsql/client'
import { desktopQueuedMessageSchema, type DesktopQueueScope, type DesktopQueueWrite } from '../queued-message'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { withRosterWrite } from './roster-writes'
import { findDesktopAgent, findDesktopSession } from './store'

async function targetOf(db: Client, agentId: string, scope: DesktopQueueScope) {
    await assertCoworkerNotDeleting(db, agentId)
    if (!await findDesktopAgent(db, agentId)) throw new DesktopHttpError(404, 'Coworker not found')
    let sessionId = scope.sessionId
    if (sessionId && (await findDesktopSession(db, sessionId))?.agentId !== agentId) throw new DesktopHttpError(404, 'Conversation not found for this coworker')
    if (scope.tabUid) {
        const first = await db.execute({ sql: `SELECT s.id FROM desktop_tab_starts t JOIN desktop_sessions s ON s.engine_session_id = t.engine_session_id
            WHERE t.agent_id = ? AND t.uid = ? AND s.agent_id = ?`, args: [agentId, scope.tabUid, agentId] })
        const firstId = first.rows[0]?.id ? String(first.rows[0].id) : undefined
        if (!sessionId && firstId) sessionId = firstId
        if (!sessionId) {
            const layout = await db.execute({ sql: `SELECT 1 FROM desktop_agent_tabs a, json_each(a.layout, '$.tabs') t
                WHERE a.agent_id = ? AND json_extract(t.value, '$.uid') = ? AND json_extract(t.value, '$.id') IS NULL`, args: [agentId, scope.tabUid] })
            if (!layout.rows.length) throw new DesktopHttpError(404, 'New conversation tab not found')
        }
        // The blank tab's first-response mapping is authoritative. Never move a queue merely
        // because a different existing conversation was selected in that tab.
        if (sessionId && firstId === sessionId) {
            const old = await db.execute({ sql: 'SELECT message_id, payload FROM desktop_queued_messages WHERE agent_id = ? AND target = ?', args: [agentId, 'tab:' + scope.tabUid] })
            if (old.rows.length) {
                const current = await db.execute({ sql: 'SELECT message_id FROM desktop_queued_messages WHERE agent_id = ? AND target = ?', args: [agentId, 'session:' + sessionId] })
                if (current.rows.length) {
                    // Return the original tab's draft for review, without replacing the queue
                    // already bound to the conversation. After this item is sent/discarded, the
                    // conversation's own queue becomes visible again. Its ID guards every write.
                    const item = desktopQueuedMessageSchema.parse(JSON.parse(String(old.rows[0].payload)))
                    if (item.state === 'waiting') await db.execute({ sql: 'UPDATE desktop_queued_messages SET payload = ? WHERE agent_id = ? AND target = ?', args: [JSON.stringify({ ...item, state: 'review' }), agentId, 'tab:' + scope.tabUid] })
                    return { target: 'tab:' + scope.tabUid, sessionId: null }
                }
                await db.execute({ sql: 'UPDATE desktop_queued_messages SET target = ?, session_id = ? WHERE agent_id = ? AND target = ?', args: ['session:' + sessionId, sessionId, agentId, 'tab:' + scope.tabUid] })
            }
        }
    }
    return { target: sessionId ? 'session:' + sessionId : 'tab:' + scope.tabUid!, sessionId: sessionId ?? null }
}

async function itemAt(db: Client, agentId: string, target: string) {
    const result = await db.execute({ sql: 'SELECT payload FROM desktop_queued_messages WHERE agent_id = ? AND target = ?', args: [agentId, target] })
    return result.rows.length ? desktopQueuedMessageSchema.parse(JSON.parse(String(result.rows[0].payload))) : null
}

export function readDesktopQueue(db: Client, agentId: string, scope: DesktopQueueScope) {
    return withRosterWrite(async () => {
        const target = await targetOf(db, agentId, scope)
        return { queued: await itemAt(db, agentId, target.target) }
    })
}

export function writeDesktopQueue(db: Client, agentId: string, input: DesktopQueueWrite) {
    return withRosterWrite(async () => {
        const { target, sessionId } = await targetOf(db, agentId, input.scope)
        const current = await itemAt(db, agentId, target)
        if (input.action === 'enqueue') {
            if (current?.id === input.item.id && JSON.stringify(current) === JSON.stringify(input.item)) return { queued: current }
            if ((current?.id ?? null) !== input.expectedId || current?.state === 'sending') throw new DesktopHttpError(409, 'The queued message changed. Reopen this conversation before replacing it.')
            if (input.item.state !== 'waiting') throw new DesktopHttpError(400, 'A new message must wait in the queue.')
            await db.execute({ sql: `INSERT INTO desktop_queued_messages (agent_id, target, session_id, message_id, payload) VALUES (?,?,?,?,?)
                ON CONFLICT(agent_id,target) DO UPDATE SET message_id=excluded.message_id, payload=excluded.payload`, args: [agentId, target, sessionId, input.item.id, JSON.stringify(input.item)] })
            return { queued: input.item }
        }
        if (!current || current.id !== input.id) return { queued: current }
        if (input.action === 'remove') {
            await db.execute({ sql: 'DELETE FROM desktop_queued_messages WHERE agent_id = ? AND target = ? AND message_id = ?', args: [agentId, target, input.id] })
            return { queued: null }
        }
        const queued = { ...current, state: input.action === 'attempt' ? 'sending' as const : 'review' as const }
        await db.execute({ sql: 'UPDATE desktop_queued_messages SET payload = ? WHERE agent_id = ? AND target = ? AND message_id = ?', args: [JSON.stringify(queued), agentId, target, input.id] })
        return { queued }
    })
}
