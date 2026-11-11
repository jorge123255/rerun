import { DESKTOP_OPENCODE_CONNECTION_ID, RERUN_CONNECTION_ID, isDesktopSubscriptionProvider, parseDesktopSubscriptionConnectionId, type Provider } from '@rerun/contracts'
import { findConnection, listConnections } from './registry.js'
import type { LoadedConnection } from './types.js'

// Oldest first, so "the first connection of this provider" is a stable answer across reloads
// rather than whatever order readdir happened to return.
function byAge(connections: LoadedConnection[]): LoadedConnection[] {
    return [...connections].sort((a, b) => a.config.createdAt.localeCompare(b.config.createdAt) || a.id.localeCompare(b.id))
}

export async function connectionsOfProvider(provider: Provider): Promise<LoadedConnection[]> {
    return byAge((await listConnections()).filter(c => c.config.provider === provider))
}

// What an agent, a schedule or a trigger actually runs on. A connection id that resolves wins; a
// bare provider is what a template imported from another box or an MCP `update_agent` call carries,
// and it maps onto the box's oldest connection of that provider. Falling through to the keyless
// Rerun connection keeps a freshly imported agent runnable rather than inert.
export async function resolveConnection(connectionId: string | null | undefined, provider: Provider | null | undefined): Promise<LoadedConnection | null> {
    const direct = await findConnection(connectionId)
    if (connectionId === DESKTOP_OPENCODE_CONNECTION_ID) return direct
    if (parseDesktopSubscriptionConnectionId(connectionId) || isDesktopSubscriptionProvider(provider)) {
        return direct && (provider == null || direct.config.provider === provider) ? direct : null
    }
    if (direct) return direct
    if (provider === 'custom' || provider === 'opencode') return null
    if (provider) {
        const match = (await connectionsOfProvider(provider))[0]
        if (match) return match
    }
    return findConnection(RERUN_CONNECTION_ID)
}

// A connection serves a model when the model is one it was curated to offer. `extraModels` carries
// the ids a custom OpenRouter router advertises, which the catalog cannot know about.
export function servesModel(connection: LoadedConnection, model: string | null | undefined): boolean {
    if (!model) return false
    return connection.config.models.includes(model) || connection.config.extraModels.includes(model)
}
