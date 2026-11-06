import type { Client } from '@libsql/client'
import { raw } from '../../db/client.js'
import { newId } from '../../lib/ids.js'
import { canonicalDesktopApiConnectionAuthority } from './canonical.js'
import { createDesktopApiConnectionService, type DesktopApiConnectionAuthority } from './service.js'
import { DESKTOP_API_CONNECTIONS_SCHEMA_SQL, sqliteDesktopApiConnectionStore } from './store.js'

export { DESKTOP_API_CONNECTIONS_SCHEMA_SQL }

export async function initializeDesktopApiConnections(database: Client = raw()) {
    await database.executeMultiple(DESKTOP_API_CONNECTIONS_SCHEMA_SQL)
    return sqliteDesktopApiConnectionStore(database)
}

export async function createDesktopApiConnectionRuntime({ workspaceId, database = raw(), pendingRuns, stopAndDrain, connectionId, revision, now }: {
    workspaceId: number
    database?: Client
    pendingRuns: DesktopApiConnectionAuthority['pendingRuns']
    stopAndDrain?: DesktopApiConnectionAuthority['stopAndDrain']
    connectionId?: () => string
    revision?: () => string
    now?: () => Date
}) {
    const store = await initializeDesktopApiConnections(database)
    return createDesktopApiConnectionService({
        authority: canonicalDesktopApiConnectionAuthority({ workspaceId, pendingRuns, stopAndDrain }),
        store,
        connectionId: connectionId ?? (() => `cnx_${newId()}`),
        revision: revision ?? (() => `rev_${newId()}`),
        now: now ?? (() => new Date()),
    })
}
