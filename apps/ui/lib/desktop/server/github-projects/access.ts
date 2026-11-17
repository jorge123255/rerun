import 'server-only'
import { existsSync } from 'node:fs'
import { desktopGithubRepositoryId, desktopRerunGrantsOf, type DesktopForemanChatRef } from '@rerun/contracts'
import { getAgent } from '@/lib/engine/client'
import { acceptedGithubProjects } from '../../foreman-intake/github-projects'
import type { DesktopGithubTeamAccess } from '../../github-team-access'
import { openDesktopDatabase } from '../database'
import { hostGhPath } from '../repository-workspace/git'
import { desktopAppStoreBuild, type DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { listDesktopAgents } from '../store'
import { readDesktopGithubProjects } from './store'

/**
 * The coworkers set up for this conversation's GitHub projects, and whether each may work on its
 * repository. Read only: nothing is switched here, and no sign-in is looked at.
 */
export async function readDesktopGithubTeamAccess(runtime: DesktopRuntime, chat: DesktopForemanChatRef): Promise<DesktopGithubTeamAccess> {
    const host = { git: existsSync('/usr/bin/git'), gh: hostGhPath() !== null, directBuild: !desktopAppStoreBuild() }
    const db = await openDesktopDatabase(runtime.dataRoot)
    const accepted = acceptedGithubProjects(await readDesktopGithubProjects(db, chat))
    const ids = new Set(accepted?.projects.map(project => project.id) ?? [])
    if (!ids.size) return { team: [], host }
    const engine = engineOf(runtime)
    const team: DesktopGithubTeamAccess['team'] = []
    for (const agent of await listDesktopAgents(db)) {
        const detail = await getAgent(engine, agent.engineAgentId).catch(() => null)
        const repository = detail?.id === agent.engineAgentId ? detail.config.desktopRepository : null
        if (!detail || !repository || !ids.has(desktopGithubRepositoryId(repository))) continue
        team.push({ id: agent.id, name: agent.name, repository: `${repository.owner}/${repository.name}`, ready: desktopRerunGrantsOf(detail.config.tools).repositoryWorkspace })
        if (team.length >= 250) break
    }
    return { team, host }
}
