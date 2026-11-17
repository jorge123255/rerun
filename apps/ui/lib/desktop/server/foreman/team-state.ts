import 'server-only'
import type { Client } from '@libsql/client'
import { DESKTOP_TEAM_CHANGE_PERMISSIONS, desktopRerunGrantsOf, type ConnectionSummary, type DesktopTeamChangePermission } from '@rerun/contracts'
import { getAgent } from '@/lib/engine/client'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { readDesktopSetupView } from '../setup/service'
import { listDesktopAgents } from '../store'

/**
 * What the Chief of Staff is told about each coworker so it can set a team up without asking the
 * person what the app already knows: whether it is on, the model it answers with, which of the
 * permissions a proposal may name it already has, and where its setup stands. Names and states
 * only: no key, no address, no instructions, no conversation.
 */
export type DesktopTeamCoworkerState = {
    name: string
    on: boolean
    /** "Provider · model", or null when it follows the workspace default or could not be read. */
    model: string | null
    allowed: DesktopTeamChangePermission[] | null
    setup: 'needed' | 'started' | 'done' | 'none' | 'unknown'
}

export const DESKTOP_TEAM_STATE_LIMIT = 40
const READ_TIMEOUT_MS = 2_500

type Connections = readonly Pick<ConnectionSummary, 'id' | 'name'>[]

async function coworkerState(runtime: DesktopRuntime, agent: { id: string; name: string; enabled: boolean; engineAgentId: string }, connections: Connections): Promise<DesktopTeamCoworkerState> {
    const [detail, setup] = await Promise.allSettled([getAgent(engineOf(runtime), agent.engineAgentId), readDesktopSetupView(runtime, agent.id)])
    const config = detail.status === 'fulfilled' ? detail.value.config : null
    const connection = config?.connectionId ? connections.find(item => item.id === config.connectionId) ?? null : null
    const grants = config ? desktopRerunGrantsOf(config.tools) : null
    const view = setup.status === 'fulfilled' ? setup.value : null
    return {
        name: agent.name,
        on: agent.enabled,
        model: connection && config?.model ? `${connection.name} · ${config.model}` : null,
        allowed: grants ? DESKTOP_TEAM_CHANGE_PERMISSIONS.filter(id => grants[id] === true) : null,
        setup: !view ? 'unknown'
            : view.completedAt ? 'done'
            : view.sessionId ? 'started'
            : view.required === true && view.prompt.trim().length > 0 && !view.skipped ? 'needed'
            : 'none',
    }
}

/** Every coworker's state, read side by side. A coworker that cannot be read in time keeps its name and switch only. */
export async function readDesktopTeamState(runtime: DesktopRuntime, db: Client, connections: Connections): Promise<DesktopTeamCoworkerState[]> {
    const agents = (await listDesktopAgents(db)).slice(0, DESKTOP_TEAM_STATE_LIMIT)
    const bare = (agent: (typeof agents)[number]): DesktopTeamCoworkerState => ({ name: agent.name, on: agent.enabled, model: null, allowed: null, setup: 'unknown' })
    return Promise.all(agents.map(agent => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<DesktopTeamCoworkerState>(resolve => { timer = setTimeout(() => resolve(bare(agent)), READ_TIMEOUT_MS) })
        return Promise.race([coworkerState(runtime, agent, connections).catch(() => bare(agent)), late]).finally(() => clearTimeout(timer))
    }))
}
