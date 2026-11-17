import 'server-only'
import type { Client } from '@libsql/client'
import { DESKTOP_TEAM_CHANGE_PERMISSIONS, desktopRerunGrantsOf, FOREMAN_AGENT_ID, type ConnectionSummary, type DesktopTeamChangePermission } from '@rerun/contracts'
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
    /** The coworkers it may ask for help, by name; 'everyone' when that is all the others. Absent when not read. */
    asks?: string[] | 'everyone'
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

/** Who may ask whom, from the app's own list. Empty when it cannot be read: the Chief of Staff is then told nothing about it. */
async function readCallAllows(db: Client): Promise<Map<string, Set<string>> | null> {
    try {
        const rows = (await db.execute('SELECT caller_agent_id, target_agent_id FROM desktop_coworker_call_allows')).rows
        const allows = new Map<string, Set<string>>()
        for (const row of rows) { const caller = String(row.caller_agent_id); allows.set(caller, (allows.get(caller) ?? new Set()).add(String(row.target_agent_id))) }
        return allows
    } catch { return null }
}
const asksOf = (allows: Map<string, Set<string>>, caller: string, others: readonly { id: string; name: string }[]): string[] | 'everyone' => {
    const allowed = others.filter(other => allows.get(caller)?.has(other.id))
    return others.length > 0 && allowed.length === others.length ? 'everyone' : allowed.map(other => other.name)
}

/** The coworkers the Chief of Staff itself may message, by name. */
export async function readDesktopChiefAsks(db: Client): Promise<string[] | 'everyone' | null> {
    const allows = await readCallAllows(db)
    return allows ? asksOf(allows, FOREMAN_AGENT_ID, await listDesktopAgents(db)) : null
}

/** Every coworker's state, read side by side. A coworker that cannot be read in time keeps its name and switch only. */
export async function readDesktopTeamState(runtime: DesktopRuntime, db: Client, connections: Connections): Promise<DesktopTeamCoworkerState[]> {
    const everyone = await listDesktopAgents(db)
    const agents = everyone.slice(0, DESKTOP_TEAM_STATE_LIMIT)
    const allows = await readCallAllows(db)
    const withAsks = (agent: (typeof agents)[number], state: DesktopTeamCoworkerState): DesktopTeamCoworkerState => allows ? { ...state, asks: asksOf(allows, agent.id, everyone.filter(other => other.id !== agent.id)) } : state
    const bare = (agent: (typeof agents)[number]): DesktopTeamCoworkerState => ({ name: agent.name, on: agent.enabled, model: null, allowed: null, setup: 'unknown' })
    return Promise.all(agents.map(agent => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<DesktopTeamCoworkerState>(resolve => { timer = setTimeout(() => resolve(bare(agent)), READ_TIMEOUT_MS) })
        return Promise.race([coworkerState(runtime, agent, connections).catch(() => bare(agent)), late]).then(state => withAsks(agent, state)).finally(() => clearTimeout(timer))
    }))
}
