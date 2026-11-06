import 'server-only'
import type { Client } from '@libsql/client'
import { EngineRequestError, getAgent, patchAgent } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { assertDesktopCreationSettled } from './creation-guard'
import { withRosterWrite } from './roster-writes'
import { findDesktopAgent, listDesktopAgents, type DesktopAgent } from './store'

export const disabledCoworkerMessage = 'This coworker is switched off. Enable it from the board to send a message.'
const unavailable = 'Could not confirm whether this coworker is enabled. Try again.'

export async function assertDesktopCoworkerEnabled(engine: EngineConnection, agent: DesktopAgent) {
    let detail
    try { detail = await getAgent(engine, agent.engineAgentId) }
    catch (error) {
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
        throw new DesktopHttpError(502, unavailable)
    }
    if (detail.id !== agent.engineAgentId) throw new DesktopHttpError(502, unavailable)
    if (!detail.config.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
}

async function saveEnabled(db: Client, agent: DesktopAgent, enabled: boolean) {
    if (agent.enabled !== enabled) await db.execute({
        sql: 'UPDATE desktop_agents SET enabled = ?, updated_at = ? WHERE id = ? AND workspace_id = 1',
        args: [Number(enabled), new Date().toISOString(), agent.id],
    })
    return (await findDesktopAgent(db, agent.id))!
}

// The engine config is authoritative. This projection keeps the board available if the engine
// cannot be read, and a fresh read repairs an engine write whose acknowledgement was lost.
export function reconcileDesktopEnabled(db: Client, engine: EngineConnection) {
    return withRosterWrite(async () => {
        const agents = await listDesktopAgents(db)
        const details = await Promise.all(agents.map(agent => getAgent(engine, agent.engineAgentId).catch(() => null)))
        for (let index = 0; index < agents.length; index++) {
            const agent = agents[index], detail = details[index]
            if (detail?.id === agent.engineAgentId) await saveEnabled(db, agent, detail.config.enabled)
        }
    })
}

export function setDesktopCoworkerEnabled(db: Client, engine: EngineConnection, id: string, enabled: boolean) {
    return withRosterWrite(async () => {
        await assertCoworkerNotDeleting(db, id)
        await assertDesktopCreationSettled(db, id)
        const agent = await findDesktopAgent(db, id)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        try {
            // Read even when the projection agrees: an interrupted earlier request may have
            // reached the engine without reaching the local database.
            const before = await getAgent(engine, agent.engineAgentId)
            if (before.id !== agent.engineAgentId) throw new Error(unavailable)
            if (before.config.enabled === enabled) return saveEnabled(db, agent, enabled)
            const detail = await patchAgent(engine, agent.engineAgentId, { enabled })
            if (detail.id !== agent.engineAgentId || detail.config.enabled !== enabled) throw new Error(unavailable)
            return saveEnabled(db, agent, enabled)
        } catch (error) {
            const detail = await getAgent(engine, agent.engineAgentId).catch(() => null)
            if (detail?.id === agent.engineAgentId) {
                const observed = await saveEnabled(db, agent, detail.config.enabled)
                if (detail.config.enabled === enabled) return observed
            }
            if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
            throw new DesktopHttpError(502, unavailable)
        }
    })
}
