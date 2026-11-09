import 'server-only'
import type { Client } from '@libsql/client'
import { FOREMAN_WORKSPACE_CATALOG_ID, type ForemanWorkspaceSnapshot } from '@rerun/contracts'
import { openDesktopDatabase } from './database'
import { readDesktopRuntime, type DesktopRuntime } from './runtime'
import { readDesktopBoardState } from './spaces'
import { listDesktopAgents } from './store'

type SnapshotDeps = {
    runtime: () => Promise<Pick<DesktopRuntime, 'workspaceId' | 'dataRoot' | 'launchNonce'>>
    open: (dataRoot: string) => Promise<Client>
}

const production: SnapshotDeps = {
    runtime: readDesktopRuntime,
    open: openDesktopDatabase,
}

/** Runtime identity check. A separate explicit grant is required before using these reads. */
export async function foremanWorkspaceReadRuntimeMatches(workspaceId: string, readRuntime: SnapshotDeps['runtime'] = production.runtime): Promise<boolean> {
    try {
        const first = await readRuntime()
        if (String(first.workspaceId) !== workspaceId) return false
        const second = await readRuntime()
        return String(second.workspaceId) === workspaceId && second.launchNonce === first.launchNonce
    } catch {
        return false
    }
}

export async function readForemanWorkspaceSnapshot(workspaceId: string, deps: SnapshotDeps = production): Promise<ForemanWorkspaceSnapshot> {
    let runtime: Pick<DesktopRuntime, 'workspaceId' | 'dataRoot' | 'launchNonce'>
    try {
        runtime = await deps.runtime()
    } catch {
        return { kind: 'uncertain' }
    }
    if (String(runtime.workspaceId) !== workspaceId) return { kind: 'other-workspace' }
    try {
        const db = await deps.open(runtime.dataRoot)
        const first = await readDesktopBoardState(db)
        const agents = await listDesktopAgents(db)
        const second = await readDesktopBoardState(db)
        const again = await deps.runtime()
        if (String(again.workspaceId) !== workspaceId || again.launchNonce !== runtime.launchNonce || first.revision !== second.revision) return { kind: 'uncertain' }
        const localId = Number(FOREMAN_WORKSPACE_CATALOG_ID)
        return {
            kind: 'ready',
            workspaceId,
            catalogWorkspaceId: FOREMAN_WORKSPACE_CATALOG_ID,
            revision: second.revision,
            boxes: second.spaces.map(space => ({ id: space.id, name: space.name })),
            roster: agents.filter(agent => agent.workspaceId === localId).map(agent => ({
                id: agent.id,
                workspaceId,
                name: agent.name,
                handle: null,
                description: agent.description,
                spaceId: agent.spaceId ?? null,
                enabled: agent.enabled,
                deleting: false,
            })),
            foreignIds: agents.filter(agent => agent.workspaceId !== localId).map(agent => agent.id),
        }
    } catch {
        return { kind: 'uncertain' }
    }
}
