import { notFound } from '../lib/errors.js'
import { clearAgentCache } from '../agents/registry.js'
import { isPathSegment } from '../config/paths.js'
import { connectionExists, listConnectionIds, loadConnectionFromDisk } from './loader.js'
import { desktopCustomProviderBinding, readRegisteredCustomConnection } from '../desktop/custom-providers/binding.js'
import type { LoadedConnection } from './types.js'

// One instance per connection, shared by every agent pointing at it. Deliberate: a token refresh
// mutates this single object, so the whole box sees the fresh credential at once instead of each
// agent carrying its own copy and racing to rotate it.
const cache = new Map<string, LoadedConnection>()

export async function getConnection(id: string): Promise<LoadedConnection> {
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
    const custom = await readRegisteredCustomConnection(id)
    return custom ?? (connectionExists(id) ? getConnection(id) : null)
}

export async function listConnections(): Promise<LoadedConnection[]> {
    const ids = await listConnectionIds()
    const custom = await desktopCustomProviderBinding()?.ids() ?? []
    return Promise.all([...new Set([...ids, ...custom])].map(id => getConnection(id)))
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
