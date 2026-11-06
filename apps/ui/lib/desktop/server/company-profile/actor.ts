import 'server-only'
import type { Client } from '@libsql/client'
import type { DesktopCompanyProfileTrustedActorAuthority, DesktopForemanChatRef } from '@rerun/contracts'

export function firstNameFromLocalProfile(displayName: string): string | null {
    const normalized = displayName.trim().replace(/\s+/g, ' ')
    if (!normalized || normalized.includes('@') || /^(?:local[ -]user|user|owner|admin|administrator)$/i.test(normalized)) return null
    const first = normalized.split(' ')[0].trim()
    return first && first.length <= 100 ? first : null
}

export function createDesktopLocalProfileActorAuthority(db: Client): DesktopCompanyProfileTrustedActorAuthority {
    return {
        async readKnownFirstName(_chat: DesktopForemanChatRef) {
            const row = (await db.execute('SELECT display_name FROM desktop_profile WHERE id=1')).rows[0]
            return row ? firstNameFromLocalProfile(String(row.display_name)) : null
        },
    }
}
