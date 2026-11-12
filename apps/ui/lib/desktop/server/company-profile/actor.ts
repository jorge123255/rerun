import 'server-only'
import type { DesktopRuntime } from '../runtime'
import { desktopProfileDatabase, readDesktopProfile } from '../local-profile'
import type { DesktopCompanyProfileTrustedActorAuthority, DesktopForemanChatRef } from '@rerun/contracts'

export function firstNameFromLocalProfile(displayName: string): string | null {
    const normalized = displayName.trim().replace(/\s+/g, ' ')
    if (!normalized || normalized.includes('@') || /^(?:local[ -]user|user|owner|admin|administrator)$/i.test(normalized)) return null
    const first = normalized.split(' ')[0].trim()
    return first && first.length <= 100 ? first : null
}

export function createDesktopLocalProfileActorAuthority(runtime: DesktopRuntime): DesktopCompanyProfileTrustedActorAuthority {
    return {
        async readKnownFirstName(_chat: DesktopForemanChatRef) {
            const profile = await readDesktopProfile(await desktopProfileDatabase(runtime))
            return firstNameFromLocalProfile(profile.displayName)
        },
    }
}
