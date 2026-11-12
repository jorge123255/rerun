import 'server-only'
import type { Client } from '@libsql/client'
import { FOREMAN_WORKSPACE_CATALOG_ID, type ForemanWorkspaceSnapshot } from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import { foremanFilePermissionSnapshotSchema } from '../foreman-file-permissions'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import { readDesktopRuntime, type DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { readDesktopRosterSnapshot } from './store'
import { assertDesktopWorkspaceAdmission } from './workspace-admission'

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

export async function readGrantedForemanWorkspaceSnapshot(runtime: DesktopRuntime, workspaceId: string, signal: AbortSignal): Promise<ForemanWorkspaceSnapshot> {
    const readRuntime = async () => {
        signal.throwIfAborted()
        const current = await readDesktopRuntime()
        if (String(current.workspaceId) !== workspaceId || current.workspaceId !== runtime.workspaceId
            || current.launchNonce !== runtime.launchNonce || current.dataRoot !== runtime.dataRoot) {
            throw new DesktopHttpError(409, 'The workspace or app launch changed.')
        }
        return current
    }
    const checkGrant = async () => {
        await readRuntime()
        assertDesktopWorkspaceAdmission(runtime)
        const permissions = await request(engineOf(runtime), '/desktop/foreman/file-permissions', {
            method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        }, foremanFilePermissionSnapshotSchema.parse)
        signal.throwIfAborted()
        assertDesktopWorkspaceAdmission(runtime)
        if (permissions.workspaceId !== workspaceId || permissions.launchNonce !== runtime.launchNonce
            || permissions.grants.foremanWorkspaceRead !== true) throw new DesktopHttpError(409, 'Workspace metadata access is unavailable.')
    }
    await checkGrant()
    const snapshot = await readForemanWorkspaceSnapshot(workspaceId, { ...production, runtime: readRuntime })
    await checkGrant()
    return snapshot
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
        const { board, agents } = await readDesktopRosterSnapshot(db)
        const again = await deps.runtime()
        if (String(again.workspaceId) !== workspaceId || again.launchNonce !== runtime.launchNonce || again.dataRoot !== runtime.dataRoot) return { kind: 'uncertain' }
        const localId = Number(FOREMAN_WORKSPACE_CATALOG_ID)
        return {
            kind: 'ready',
            workspaceId,
            catalogWorkspaceId: FOREMAN_WORKSPACE_CATALOG_ID,
            revision: board.revision,
            boxes: board.spaces.map(space => ({ id: space.id, name: space.name })),
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
