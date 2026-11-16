import 'server-only'
import { desktopGithubRepositoryId, desktopRerunGrantsOf, type DesktopForemanChatRef } from '@rerun/contracts'
import { getAgent } from '@/lib/engine/client'
import { acceptedGithubProjects } from '../../foreman-intake/github-projects'
import type { DesktopGithubTeamAccess } from '../../github-team-access'
import { openDesktopDatabase } from '../database'
import { openDesktopManagedApps } from '../managed-apps/binding'
import { COMPOSIO_CONNECT } from '../managed-apps/client'
import { COMPOSIO_CONNECT_NAME } from '../managed-apps/service'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { listDesktopAgents } from '../store'
import { openDesktopVault } from '../vault/binding'
import { readDesktopGithubProjects } from './store'

/**
 * The coworkers set up for this conversation's GitHub projects, and whether each can reach GitHub.
 * Read only: nothing is assigned or switched here.
 */
export async function readDesktopGithubTeamAccess(runtime: DesktopRuntime, chat: DesktopForemanChatRef): Promise<DesktopGithubTeamAccess> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const accepted = acceptedGithubProjects(await readDesktopGithubProjects(db, chat))
    const ids = new Set(accepted?.projects.map(project => project.id) ?? [])
    const empty: DesktopGithubTeamAccess = { team: [], via: null, entry: null, account: null, alsoGives: [] }
    if (!ids.size) return empty

    const engine = engineOf(runtime)
    const found: { id: string; name: string; repository: string; allowed: boolean }[] = []
    for (const agent of await listDesktopAgents(db)) {
        const detail = await getAgent(engine, agent.engineAgentId).catch(() => null)
        const repository = detail?.id === agent.engineAgentId ? detail.config.desktopRepository : null
        if (!detail || !repository || !ids.has(desktopGithubRepositoryId(repository))) continue
        found.push({ id: agent.id, name: agent.name, repository: `${repository.owner}/${repository.name}`, allowed: desktopRerunGrantsOf(detail.config.tools).mcp })
        if (found.length >= 250) break
    }
    if (!found.length) return empty

    const managed = await (await openDesktopManagedApps(runtime)).view()
    const github = managed.accounts.find(account => account.slug.toLowerCase() === 'github' && account.status === 'active')
    if (!managed.configured || !github) return { ...empty, team: found.map(member => ({ ...member, assigned: false })) }
    if (managed.connector === COMPOSIO_CONNECT_NAME) {
        const listed = (await (await openDesktopVault(runtime)).list()).entries.find(entry => 'kind' in entry && entry.kind === 'mcp' && entry.name === COMPOSIO_CONNECT_NAME && entry.url === COMPOSIO_CONNECT)
        if (!listed) return { ...empty, team: found.map(member => ({ ...member, assigned: false })) }
        return {
            team: found.map(member => ({ ...member, assigned: listed.sharedWithAll || listed.agentIds.includes(member.id) })),
            via: 'composio-connect', account: null,
            entry: { id: listed.id, revision: listed.revision, sharedWithAll: listed.sharedWithAll, agentIds: listed.agentIds },
            alsoGives: managed.accounts.filter(account => account.status === 'active' && account.id !== github.id).map(account => account.name).slice(0, 50),
        }
    }
    // A project key hands out GitHub alone, and its tools need no further permission.
    return { team: found.map(member => ({ ...member, assigned: github.agentIds.includes(member.id), allowed: true })), via: 'composio-project', entry: null, account: { id: github.id }, alsoGives: [] }
}
