import 'server-only'
import type { Client, Transaction } from '@libsql/client'
import type { z } from 'zod'
import { desktopRecentCoworkerVisitSchema, type DesktopRecentCoworkers } from '../recent-coworkers.schema'
import { DesktopHttpError } from './auth'

type Reader = Pick<Client, 'execute'>

export async function readDesktopRecentCoworkers(db: Reader): Promise<DesktopRecentCoworkers> {
    // One statement keeps the revision and list from the same SQLite snapshot.
    const result = await db.execute(`SELECT s.revision, r.agent_id FROM
        (SELECT COALESCE((SELECT revision FROM desktop_recent_state WHERE workspace_id = 1), 0) AS revision) s
        LEFT JOIN (SELECT r.agent_id, r.visit_order FROM desktop_recent_coworkers r
            JOIN desktop_agents a ON a.id = r.agent_id
            WHERE a.workspace_id = 1 AND NOT EXISTS (SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id)
            ORDER BY r.visit_order DESC, r.agent_id LIMIT 5) r ON 1 = 1
        ORDER BY r.visit_order DESC, r.agent_id`)
    return { revision: Number(result.rows[0]?.revision ?? 0), recentAgentIds: result.rows.flatMap(row => row.agent_id === null ? [] : [String(row.agent_id)]) }
}

export type RecentVisitResult = { status: 200 | 409; recent: DesktopRecentCoworkers }

// The last accepted request and comparison revision make an uncertain write retry safe.
// A delayed request from before a newer visit can only receive a conflict, never reorder it.
export async function rememberDesktopCoworker(db: Client, visit: z.infer<typeof desktopRecentCoworkerVisitSchema>): Promise<RecentVisitResult> {
    let tx: Transaction | undefined
    try {
        tx = await db.transaction('write')
        const owner = await tx.execute({ sql: `SELECT a.id, d.completed FROM desktop_agents a
            LEFT JOIN desktop_deletions d ON d.agent_id = a.id WHERE a.id = ? AND a.workspace_id = 1`, args: [visit.agentId] })
        if (!owner.rows.length) throw new DesktopHttpError(404, 'Coworker not found')
        if (owner.rows[0].completed !== null) {
            if (Number(owner.rows[0].completed) === 1) throw new DesktopHttpError(404, 'Coworker not found')
            throw new DesktopHttpError(503, 'This coworker is being removed. Try again once that finishes.')
        }
        await tx.execute('INSERT OR IGNORE INTO desktop_recent_state (workspace_id, revision) VALUES (1, 0)')
        const result = await tx.execute('SELECT revision, request_id, agent_id FROM desktop_recent_state WHERE workspace_id = 1')
        const state = result.rows[0]
        const revision = Number(state.revision)
        if (state.request_id === visit.requestId) {
            if (state.agent_id !== visit.agentId || visit.baseRevision !== revision - 1) throw new DesktopHttpError(409, 'That visit belongs to a different request')
        } else if (revision !== visit.baseRevision) {
            const recent = await readDesktopRecentCoworkers(tx)
            await tx.commit()
            return { status: 409, recent }
        } else {
            if (revision >= Number.MAX_SAFE_INTEGER) throw new DesktopHttpError(409, 'Recent coworkers could not be saved')
            await tx.execute({ sql: 'INSERT INTO desktop_recent_coworkers (agent_id, visit_order) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET visit_order = excluded.visit_order', args: [visit.agentId, revision + 1] })
            await tx.execute(`DELETE FROM desktop_recent_coworkers WHERE agent_id NOT IN (
                SELECT r.agent_id FROM desktop_recent_coworkers r JOIN desktop_agents a ON a.id = r.agent_id
                WHERE a.workspace_id = 1
                ORDER BY r.visit_order DESC, r.agent_id LIMIT 5)`)
            await tx.execute({ sql: 'UPDATE desktop_recent_state SET revision = ?, request_id = ?, agent_id = ? WHERE workspace_id = 1', args: [revision + 1, visit.requestId, visit.agentId] })
        }
        const recent = await readDesktopRecentCoworkers(tx)
        await tx.commit()
        return { status: 200, recent }
    } finally {
        tx?.close()
    }
}
