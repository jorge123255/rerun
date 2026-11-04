import 'server-only'
import type { Client, Row } from '@libsql/client'
import { z } from 'zod'
import { EngineRequestError, request } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { DesktopHttpError } from './auth'
import { withRosterWrite } from './roster-writes'
import { findDesktopAgent } from './store'

const resultSchema = z.object({ deleted: z.string() })
const uncertain = 'Could not confirm that this coworker was deleted. Retry Delete to finish.'
const busy = 'This coworker is still working. Stop its reply or wait for it to finish, then try Delete again.'

export async function assertCoworkerNotDeleting(db: Client, id: string) {
    const result = await db.execute({ sql: 'SELECT completed FROM desktop_deletions WHERE agent_id = ?', args: [id] })
    if (result.rows[0]?.completed) throw new DesktopHttpError(404, 'Coworker not found')
    if (result.rows.length) throw new DesktopHttpError(409, 'This coworker is being deleted. Retry Delete to finish.')
}

async function finish(db: Client, receipt: Row) {
    const id = String(receipt.agent_id)
    // Explicit ownership predicates also clean workspaces created before the session foreign
    // keys existed. A copy's completed receipt stays as a tombstone against stale copy retries.
    await db.batch([
        { sql: 'DELETE FROM desktop_message_feedback WHERE agent_id = ? OR session_id IN (SELECT id FROM desktop_sessions WHERE agent_id = ?)', args: [id, id] },
        { sql: 'DELETE FROM desktop_regeneration_requests WHERE source_session_id IN (SELECT id FROM desktop_sessions WHERE agent_id = ?)', args: [id] },
        { sql: 'UPDATE desktop_regeneration_requests SET alternate_session_id = NULL WHERE alternate_session_id IN (SELECT id FROM desktop_sessions WHERE agent_id = ?)', args: [id] },
        { sql: 'DELETE FROM desktop_tab_starts WHERE agent_id = ?', args: [id] },
        { sql: 'DELETE FROM desktop_agent_tabs WHERE agent_id = ?', args: [id] },
        { sql: 'DELETE FROM desktop_rename_checks WHERE agent_id = ?', args: [id] },
        { sql: 'DELETE FROM desktop_sessions WHERE agent_id = ?', args: [id] },
        { sql: 'DELETE FROM desktop_agents WHERE id = ? AND engine_agent_id = ? AND workspace_id = 1', args: [id, String(receipt.engine_agent_id)] },
        { sql: 'UPDATE desktop_deletions SET completed = 1 WHERE agent_id = ?', args: [id] },
    ], 'write')
    return { deletedAgentId: id }
}

async function apply(db: Client, engine: EngineConnection, receipt: Row) {
    const id = String(receipt.engine_agent_id)
    try {
        const result = await request(engine, `/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }, value => resultSchema.parse(value))
        if (result.deleted !== id) throw new Error(uncertain)
    } catch (error) {
        if (error instanceof EngineRequestError && error.status === 409) {
            // A busy refusal did not accept deletion. Leave the coworker usable so Stop and
            // another typed confirmation can proceed; do not delete it later on startup.
            await db.execute({ sql: 'DELETE FROM desktop_deletions WHERE agent_id = ? AND completed = 0', args: [String(receipt.agent_id)] })
            throw new DesktopHttpError(409, busy)
        }
        // Only DELETE knows whether the entire directory was removed. A GET can return404
        // as soon as config.yaml is gone even when a failed recursive remove left data behind.
        if (error instanceof EngineRequestError && error.status === 404) return finish(db, receipt)
        throw new DesktopHttpError(502, uncertain)
    }
    return finish(db, receipt)
}

export function deleteDesktopCoworker(db: Client, engine: EngineConnection, id: string, confirmationName: string) {
    return withRosterWrite(async () => {
        const previous = await db.execute({ sql: 'SELECT * FROM desktop_deletions WHERE agent_id = ?', args: [id] })
        const receipt = previous.rows[0]
        if (receipt) {
            if (receipt.name !== confirmationName.trim()) throw new DesktopHttpError(409, 'Type the coworker’s current name to confirm deletion.')
            if (receipt.completed) return { deletedAgentId: id }
            return apply(db, engine, receipt)
        }
        const agent = await findDesktopAgent(db, id)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        if (agent.name !== confirmationName.trim()) throw new DesktopHttpError(409, 'Type the coworker’s current name to confirm deletion.')
        const copies = await db.execute({ sql: 'SELECT 1 FROM desktop_duplicates WHERE source_id = ? AND completed = 0 LIMIT 1', args: [id] })
        if (copies.rows.length) throw new DesktopHttpError(409, 'Finish the pending coworker copy before deleting its original.')
        const inserted = await db.execute({
            sql: 'INSERT INTO desktop_deletions (agent_id, engine_agent_id, name) VALUES (?, ?, ?) RETURNING *',
            args: [agent.id, agent.engineAgentId, agent.name],
        })
        return apply(db, engine, inserted.rows[0])
    })
}

export function reconcileDesktopDeletions(db: Client, engine: EngineConnection) {
    return withRosterWrite(async () => {
        const pending = await db.execute('SELECT * FROM desktop_deletions WHERE completed = 0 ORDER BY rowid')
        for (const row of pending.rows) await apply(db, engine, row).catch(() => {})
    })
}
