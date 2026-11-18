import 'server-only'
import type { Client } from '@libsql/client'
import { DESKTOP_TEAM_CHANGE_PERMISSIONS, desktopGithubProjectsRecordSchema, desktopRerunGrantsOf, FOREMAN_AGENT_ID, type ConnectionSummary, type DesktopTeamChangePermission } from '@rerun/contracts'
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
    /** Its Box on the board, by name. Absent when it sits in none or the Boxes were not read. */
    box?: string
    /** "owner/name" of the GitHub repository it works on. Absent when it has none or it was not read. */
    repository?: string
    /** The repositories the GitHub projects reader recorded as linked to its own, either way. */
    linkedRepositories?: string[]
    /**
     * The switched-on coworkers it would work with under the person's rule, by name: those on its own
     * repository or one linked to it; for a coworker without a repository, those in its Box. A fact
     * the app works out from the links above, never a permission. Absent when not read.
     */
    teammates?: string[]
}

/** Repository links the GitHub projects reader recorded, as pairs of lowercase "owner/name" ids. */
export type DesktopTeamProjectLinks = { links: [string, string][] }

export const DESKTOP_TEAM_STATE_LIMIT = 40
const READ_TIMEOUT_MS = 2_500

type Connections = readonly Pick<ConnectionSummary, 'id' | 'name'>[]

async function coworkerState(runtime: DesktopRuntime, agent: { id: string; name: string; enabled: boolean; engineAgentId: string }, connections: Connections): Promise<DesktopTeamCoworkerState> {
    const [detail, setup] = await Promise.allSettled([getAgent(engineOf(runtime), agent.engineAgentId), readDesktopSetupView(runtime, agent.id)])
    const config = detail.status === 'fulfilled' ? detail.value.config : null
    const connection = config?.connectionId ? connections.find(item => item.id === config.connectionId) ?? null : null
    const grants = config ? desktopRerunGrantsOf(config.tools) : null
    const view = setup.status === 'fulfilled' ? setup.value : null
    const repository = config?.desktopRepository
    return {
        name: agent.name,
        on: agent.enabled,
        ...(repository ? { repository: `${repository.owner}/${repository.name}` } : {}),
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

/** Each coworker's Box by name, or null when the Boxes cannot be read. */
async function readBoxes(db: Client): Promise<Map<string, string> | null> {
    try {
        const rows = (await db.execute('SELECT p.agent_id, s.name FROM desktop_space_placements p JOIN desktop_spaces s ON s.id = p.space_id')).rows
        return new Map(rows.map(row => [String(row.agent_id), String(row.name)]))
    } catch { return null }
}

/**
 * The repository links the GitHub projects reader recorded in this workspace's Chief of Staff
 * conversations: the current set of each, without projects the person removed. Null when unread.
 */
export async function readDesktopTeamProjectLinks(db: Client, workspaceId: string): Promise<DesktopTeamProjectLinks | null> {
    try {
        const rows = (await db.execute({ sql: 'SELECT body FROM desktop_intake_github_projects WHERE workspace_id=? AND is_current=1', args: [workspaceId] })).rows
        const links: [string, string][] = []
        for (const row of rows) {
            const parsed = (() => { try { return desktopGithubProjectsRecordSchema.safeParse(JSON.parse(String(row.body))) } catch { return null } })()
            if (!parsed?.success) continue
            const kept = new Set(parsed.data.projects.filter(project => !project.removed).map(project => project.id))
            for (const link of parsed.data.links) if (kept.has(link.from) && kept.has(link.to)) links.push([link.from, link.to])
        }
        return { links }
    } catch (error) {
        // No conversation has read GitHub projects yet: nothing is linked.
        return /no such table/i.test(String(error)) ? { links: [] } : null
    }
}

const repositoryId = (name: string) => name.toLowerCase()

/** The person's rule for who works with whom, worked out from repositories, links and Boxes. */
export function withDesktopTeammates(team: readonly (DesktopTeamCoworkerState & { id: string })[], boxes: Map<string, string> | null, projects: DesktopTeamProjectLinks | null): DesktopTeamCoworkerState[] {
    const linked = (a: string, b: string) => a === b || !!projects?.links.some(([from, to]) => (from === a && to === b) || (from === b && to === a))
    // A repository is only known for a coworker whose settings were read.
    const known = team.every(member => member.allowed !== null || member.repository !== undefined)
    return team.map(({ id, ...member }) => {
        const box = boxes?.get(id)
        const own = member.repository ? repositoryId(member.repository) : null
        const linkedRepositories = own && projects ? [...new Set(team.flatMap(other => other.repository && repositoryId(other.repository) !== own && linked(own, repositoryId(other.repository)) ? [other.repository] : []))] : undefined
        const others = team.filter(other => other.id !== id && other.on)
        const teammates = !known || (own ? !projects : !boxes) ? undefined
            : own ? others.filter(other => other.repository && linked(own, repositoryId(other.repository))).map(other => other.name)
            : box ? others.filter(other => boxes!.get(other.id) === box).map(other => other.name) : []
        return { ...member, ...(box ? { box } : {}), ...(linkedRepositories ? { linkedRepositories } : {}), ...(teammates ? { teammates } : {}) }
    })
}

/** Every coworker's state, read side by side. A coworker that cannot be read in time keeps its name and switch only. */
export async function readDesktopTeamState(runtime: DesktopRuntime, db: Client, connections: Connections): Promise<DesktopTeamCoworkerState[]> {
    const everyone = await listDesktopAgents(db)
    const agents = everyone.slice(0, DESKTOP_TEAM_STATE_LIMIT)
    const [allows, boxes, projects] = await Promise.all([readCallAllows(db), readBoxes(db), readDesktopTeamProjectLinks(db, String(runtime?.workspaceId ?? 1))])
    const withAsks = (agent: (typeof agents)[number], state: DesktopTeamCoworkerState): DesktopTeamCoworkerState => allows ? { ...state, asks: asksOf(allows, agent.id, everyone.filter(other => other.id !== agent.id)) } : state
    const bare = (agent: (typeof agents)[number]): DesktopTeamCoworkerState => ({ name: agent.name, on: agent.enabled, model: null, allowed: null, setup: 'unknown' })
    const states = await Promise.all(agents.map(agent => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<DesktopTeamCoworkerState>(resolve => { timer = setTimeout(() => resolve(bare(agent)), READ_TIMEOUT_MS) })
        return Promise.race([coworkerState(runtime, agent, connections).catch(() => bare(agent)), late]).then(state => withAsks(agent, state)).finally(() => clearTimeout(timer))
    }))
    return withDesktopTeammates(states.map((state, index) => ({ ...state, id: agents[index]!.id })), boxes, projects)
}
