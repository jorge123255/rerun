import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { allocateHandle } from '@/lib/agent-handle'
import { EngineRequestError, getAgent, patchAgent, request } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { withRosterWrite } from './roster-writes'
import { DesktopHttpError } from './auth'
import { findDesktopAgent, type DesktopAgent } from './store'

const indexSchema = z.object({ agents: z.array(z.object({ id: z.string(), name: z.string() })) })
const unavailable = 'Could not confirm the coworker’s new name. Try again.'
type Rename = { name: string; handle: string; operationId: string }

async function finish(db: Client, agent: DesktopAgent, desired: Rename) {
    const updatedAt = new Date().toISOString()
    const [update] = await db.batch([
        { sql: `UPDATE desktop_agents SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = 1
                AND EXISTS (SELECT 1 FROM desktop_rename_checks WHERE agent_id = desktop_agents.id AND operation_id = ?)`,
          args: [desired.name, updatedAt, agent.id, desired.operationId] },
        { sql: 'DELETE FROM desktop_rename_checks WHERE agent_id = ? AND operation_id = ?', args: [agent.id, desired.operationId] },
    ], 'write')
    if (update.rowsAffected) return { ...agent, name: desired.name, updatedAt }
    const current = await findDesktopAgent(db, agent.id)
    if (!current) throw new DesktopHttpError(404, 'Coworker not found')
    return current
}

async function confirm(db: Client, engine: EngineConnection, agent: DesktopAgent, desired: Rename, writeEnded: boolean) {
    const detail = await getAgent(engine, agent.engineAgentId).catch(() => null)
    if (!detail || detail.id !== agent.engineAgentId) return
    if (detail.config.displayName === desired.name && detail.config.name === desired.handle) return finish(db, agent, desired)
    if (writeEnded) await db.execute({
        sql: 'DELETE FROM desktop_rename_checks WHERE agent_id = ? AND operation_id = ?',
        args: [agent.id, desired.operationId],
    })
}

export function reconcileDesktopRenames(db: Client, engine: EngineConnection, launchNonce: string) {
    return withRosterWrite(async () => {
        const result = await db.execute('SELECT * FROM desktop_rename_checks')
        for (const row of result.rows) {
            const agent = await findDesktopAgent(db, String(row.agent_id))
            if (agent) await confirm(db, engine, agent, { name: String(row.name), handle: String(row.handle), operationId: String(row.operation_id) }, row.launch_nonce !== launchNonce)
        }
    })
}

export function renameDesktopCoworker(db: Client, engine: EngineConnection, launchNonce: string, id: string, name: string) {
    return withRosterWrite(async () => {
        const agent = await findDesktopAgent(db, id)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        const checks = await db.execute('SELECT * FROM desktop_rename_checks')
        const previous = checks.rows.find(row => row.agent_id === id)
        if (agent.name === name && !previous) return agent
        if (previous && previous.name === name) {
            const repaired = await confirm(db, engine, agent, { name, handle: String(previous.handle), operationId: String(previous.operation_id) }, previous.launch_nonce !== launchNonce)
            if (repaired) return repaired
        }

        const index = await request(engine, '/agents', { method: 'GET', cache: 'no-store' }, data => indexSchema.parse(data))
            .catch(() => { throw new DesktopHttpError(502, unavailable) })
        if (!index.agents.some(item => item.id === agent.engineAgentId)) throw new DesktopHttpError(404, 'Coworker not found')
        const taken = new Set(index.agents.filter(item => item.id !== agent.engineAgentId).map(item => item.name))
        for (const row of checks.rows) if (row.agent_id !== id) taken.add(String(row.handle))
        const reserved = await db.execute('SELECT handle FROM desktop_duplicates WHERE completed = 0')
        for (const row of reserved.rows) taken.add(String(row.handle))
        const desired = { name, handle: allocateHandle(name, taken), operationId: crypto.randomUUID() }

        // If the engine commits and the response or UI process is lost, the next bootstrap
        // can repair the label from that exact engine identity without issuing a second write.
        await db.execute({
            sql: `INSERT INTO desktop_rename_checks (agent_id, name, handle, operation_id, launch_nonce) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name, handle = excluded.handle, operation_id = excluded.operation_id, launch_nonce = excluded.launch_nonce`,
            args: [id, desired.name, desired.handle, desired.operationId, launchNonce],
        })
        try {
            const detail = await patchAgent(engine, agent.engineAgentId, { name: desired.handle, displayName: desired.name })
            if (detail.id !== agent.engineAgentId || detail.config.name !== desired.handle || detail.config.displayName !== desired.name) throw new Error(unavailable)
        } catch (error) {
            const applied = await confirm(db, engine, agent, desired, error instanceof EngineRequestError)
            if (applied) return applied
            if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
            throw new DesktopHttpError(502, unavailable)
        }
        return finish(db, agent, desired)
    })
}
