import { readDesktopOpencodeConnection } from '../desktop/opencode/registry.js'
import { DESKTOP_OPENCODE_CONNECTION_ID } from '@rerun/contracts'
import { notFound } from '../lib/errors.js'
import { clearAgentCache } from '../agents/registry.js'
import { isPathSegment } from '../config/paths.js'
import { connectionExists, listConnectionIds, loadConnectionFromDisk } from './loader.js'
import { desktopCustomProviderBinding, readRegisteredCustomConnection } from '../desktop/custom-providers/binding.js'
import type { LoadedConnection } from './types.js'
import { parseDesktopSubscriptionConnectionId } from '@rerun/contracts'
import { findDesktopSubscriptionConnection, listDesktopSubscriptionConnections } from '../desktop/subscription-acp/connections.js'

// One instance per connection, shared by every agent pointing at it. Deliberate: a token refresh
// mutates this single object, so the whole box sees the fresh credential at once instead of each
// agent carrying its own copy and racing to rotate it.
const cache = new Map<string, LoadedConnection>()

export async function getConnection(id: string): Promise<LoadedConnection> {
    if (id === DESKTOP_OPENCODE_CONNECTION_ID) {
        const connection = await readDesktopOpencodeConnection()
        if (!connection) throw notFound('connection')
        return connection
    }
    if (parseDesktopSubscriptionConnectionId(id)) {
        const connection = findDesktopSubscriptionConnection(id)
        if (!connection) throw notFound('connection')
        return connection
    }
    const custom = await readRegisteredCustomConnection(id)
    if (custom) return custom
    const cached = cache.get(id)
    if (cached) return cached
    if (!connectionExists(id)) throw notFound('connection')
    const connection = await loadConnectionFromDisk(id)
    cache.set(id, connection)
    return connection
}

export async function findConnection(id: string | null | undefined): Promise<LoadedConnection | null> {
    if (!id || !isPathSegment(id)) return null
    if (id === DESKTOP_OPENCODE_CONNECTION_ID) return readDesktopOpencodeConnection()
    if (parseDesktopSubscriptionConnectionId(id)) return findDesktopSubscriptionConnection(id)
    const custom = await readRegisteredCustomConnection(id)
    return custom ?? (connectionExists(id) ? getConnection(id) : null)
}

export async function listConnections(): Promise<LoadedConnection[]> {
    const ids = await listConnectionIds()
    const custom = await desktopCustomProviderBinding()?.ids() ?? []
    const stored = await Promise.all([...new Set([...ids.filter(id => id !== DESKTOP_OPENCODE_CONNECTION_ID && !parseDesktopSubscriptionConnectionId(id)), ...custom])].map(id => getConnection(id)))
    const opencode = await readDesktopOpencodeConnection()
    return [...stored, ...listDesktopSubscriptionConnections(), ...(opencode ? [opencode] : [])]
}

// Agents hold a reference to the shared instance, so dropping a connection from the cache has to
// drop them too — otherwise a reloaded connection would leave every agent on the stale object.
export function unloadConnection(id: string): void {
    cache.delete(id)
    clearAgentCache()
}

export async function reloadConnection(id: string): Promise<LoadedConnection> {
    unloadConnection(id)
    return getConnection(id)
}
