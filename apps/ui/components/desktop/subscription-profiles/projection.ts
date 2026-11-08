import type { DesktopSubscriptionProfileCatalog, DesktopSubscriptionProfileView } from './contract'
import { SUBSCRIPTION_PROFILE_NOT_READY } from './contract'

export function subscriptionProfileChoice(profile: DesktopSubscriptionProfileView) {
    const current = profile.availability === 'current-session'
    return {
        disabled: !current || !profile.selectable,
        badge: current ? 'Current session' : 'Unavailable',
        tone: current ? 'neutral' as const : 'orange' as const,
        detail: profile.credentialMetadataPresent ? `${profile.reason ?? SUBSCRIPTION_PROFILE_NOT_READY} Saved metadata is not a signed-in session.` : profile.reason ?? SUBSCRIPTION_PROFILE_NOT_READY,
        providerReady: false as const,
    }
}

export function subscriptionProfileLimit(catalog: DesktopSubscriptionProfileCatalog) {
    return catalog.capabilities.map(capability => capability.reason)
}
