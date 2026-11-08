import { desktopApiConnectionIdSchema } from '@rerun/contracts'
import { listConnections, findConnection } from '../../connections/registry.js'
import { createConnection, patchConnection, updateConnectionKeys, deleteConnection } from '../../connections/store.js'
import { connectionUsage, releaseConnection } from '../../connections/release.js'
import { clearBoxDefault, readBoxDefault, writeBoxDefault } from '../../connections/default.js'
import type { DesktopApiPendingRun } from '@rerun/contracts'
import { DesktopApiConnectionRefusal, type DesktopApiConnectionAuthority } from './service.js'
import { beginDesktopApiConnectionRemoval, beginDesktopApiConnectionWork, desktopApiConnectionRemovalAvailable } from './admission.js'
import { withConnectionLock } from '../../connections/lock.js'
import { withDesktopApiConnectionMutationLock } from './mutation-lock.js'

export function canonicalDesktopApiConnectionAuthority({ workspaceId, pendingRuns, stopAndDrain }: {
    workspaceId: number
    pendingRuns: DesktopApiConnectionAuthority['pendingRuns']
    stopAndDrain?: DesktopApiConnectionAuthority['stopAndDrain']
}): DesktopApiConnectionAuthority {
    return {
        workspaceId,
        list: async () => (await listConnections()).filter(connection => desktopApiConnectionIdSchema.safeParse(connection.id).success),
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
        withMutation: async effect => {
            const release = beginDesktopApiConnectionWork()
            if (!release) throw new DesktopApiConnectionRefusal('A connection is being removed. Nothing was saved.')
            // Separate from the file-store lock: the whole current/effect/revision/
            // receipt sequence is one mutation, even though its file effect has
            // released its narrower connection lock before the revision write.
            try { return await withDesktopApiConnectionMutationLock(workspaceId, effect) } finally { release() }
        },
        removalAvailable: desktopApiConnectionRemovalAvailable,
        withRemoval: async (connectionId, effect) => {
            const release = beginDesktopApiConnectionRemoval()
            if (!release) throw new DesktopApiConnectionRefusal('Wait for workspace replies and background work to finish before removing this connection.')
            // releaseConnection edits agent/default pointers, and deleteConnection
            // removes the directory; neither re-enters the connection lock.
            try { return await withConnectionLock(connectionId, effect) } finally { release() }
        },
    }
}

export type DesktopApiPendingRunAuthority = (connectionId: string) => Promise<DesktopApiPendingRun[]>
