import { listConnections, findConnection } from '../../connections/registry.js'
import { createConnection, patchConnection, updateConnectionKeys, deleteConnection } from '../../connections/store.js'
import { connectionUsage, releaseConnection } from '../../connections/release.js'
import { clearBoxDefault, readBoxDefault, writeBoxDefault } from '../../connections/default.js'
import type { DesktopApiPendingRun } from '@rerun/contracts'
import type { DesktopApiConnectionAuthority } from './service.js'

export function canonicalDesktopApiConnectionAuthority({ workspaceId, pendingRuns, stopAndDrain }: {
    workspaceId: number
    pendingRuns: DesktopApiConnectionAuthority['pendingRuns']
    stopAndDrain?: DesktopApiConnectionAuthority['stopAndDrain']
}): DesktopApiConnectionAuthority {
    return {
        workspaceId,
        list: listConnections,
        get: findConnection,
        create: createConnection,
        patch: patchConnection,
        updateKeys: updateConnectionKeys,
        usage: connectionUsage,
        release: releaseConnection,
        delete: deleteConnection,
        readDefault: readBoxDefault,
        writeDefault: writeBoxDefault,
        clearDefault: clearBoxDefault,
        pendingRuns,
        ...(stopAndDrain ? { stopAndDrain } : {}),
    }
}

export type DesktopApiPendingRunAuthority = (connectionId: string) => Promise<DesktopApiPendingRun[]>
