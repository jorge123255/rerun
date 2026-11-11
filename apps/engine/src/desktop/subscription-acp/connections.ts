import {
    desktopSubscriptionProvider, parseDesktopSubscriptionConnectionId, PROVIDER_LABELS,
    type DesktopSubscriptionProvider,
} from '@rerun/contracts'
import type { LoadedConnection } from '../../connections/types.js'
import { desktopSubscriptionChatAvailable, readDesktopSubscriptionCatalog } from './runtime.js'

function subscriptionConnection(provider: DesktopSubscriptionProvider): LoadedConnection | null {
    if (!desktopSubscriptionChatAvailable(provider)) return null
    const catalog = readDesktopSubscriptionCatalog(provider)
    if (!catalog) return null
    return {
        id: `mac-${provider}-${catalog.generation}`,
        config: {
            name: PROVIDER_LABELS[provider], provider, models: catalog.models.map(model => model.id),
            extraModels: [], createdAt: catalog.refreshedAt, subscriptionModels: catalog.models,
        },
        env: {},
    }
}

export function findDesktopSubscriptionConnection(id: string): LoadedConnection | null {
    const pin = parseDesktopSubscriptionConnectionId(id)
    if (!pin) return null
    const current = subscriptionConnection(pin.provider)
    return current?.id === id ? current : null
}

export function listDesktopSubscriptionConnections(): LoadedConnection[] {
    return desktopSubscriptionProvider.options.flatMap(provider => subscriptionConnection(provider) ?? [])
}
