import 'server-only'
import type { Client } from '@libsql/client'
import { desktopCompanyProfileAttemptSchema, type DesktopCompanyProfileField, type DesktopForemanChatRef } from '@rerun/contracts'
import { cleanSiteProfileText, DESKTOP_SITE_PROFILE_LIMITS, desktopIntakeSiteProfileSchema, type DesktopIntakeSiteProfile } from '../../foreman-intake/site-profile'
import { desktopCompanyProfileInputDigest } from './identity'

const RECENT = 12

/** Only what came from the page: a value the person typed is already in their own answers. */
function fromPage(field: DesktopCompanyProfileField, max: number): string | null {
    return field.origin === 'inference' || field.origin === 'discovery' ? cleanSiteProfileText(field.value, max) : null
}

/**
 * The newest finished read of this exact website in this conversation. The read is stored against
 * the answers as they were when it ran; later answers (industry, role, name) do not make what the
 * page said about the company any less true, so the website alone decides whether it still applies.
 * A read that cannot be confirmed is left out rather than trusted.
 */
export async function readDesktopSiteProfile(db: Client, chat: DesktopForemanChatRef, website: string | null | undefined): Promise<DesktopIntakeSiteProfile | null> {
    const site = website?.trim()
    if (!site || site.length > DESKTOP_SITE_PROFILE_LIMITS.website) return null
    const digest = desktopCompanyProfileInputDigest('enrich', site)
    let rows: Record<string, unknown>[]
    try {
        rows = (await db.execute({
            sql: "SELECT request_id,body FROM desktop_company_profile_attempts WHERE workspace_id=? AND chat_id=? AND kind='enrich' ORDER BY updated_at DESC,rowid DESC LIMIT ?",
            args: [chat.workspaceId, chat.chatId, RECENT],
        })).rows
    } catch { return null }
    for (const row of rows) {
        let body: unknown
        try { body = JSON.parse(String(row.body)) } catch { continue }
        const parsed = desktopCompanyProfileAttemptSchema.safeParse(body)
        if (!parsed.success) continue
        const attempt = parsed.data
        if (attempt.requestId !== String(row.request_id) || attempt.kind !== 'enrich' || attempt.identity.inputDigest !== digest
            || attempt.identity.chat.workspaceId !== chat.workspaceId || attempt.identity.chat.chatId !== chat.chatId) continue
        if (attempt.status !== 'succeeded' || attempt.outcome?.status !== 'succeeded' || !attempt.outcome.profile) continue
        const { name, description, offering, audience } = attempt.outcome.profile
        const profile = {
            website: site,
            readAt: attempt.updatedAt,
            name: fromPage(name, DESKTOP_SITE_PROFILE_LIMITS.name),
            description: fromPage(description, DESKTOP_SITE_PROFILE_LIMITS.text),
            offering: fromPage(offering, DESKTOP_SITE_PROFILE_LIMITS.text),
            audience: fromPage(audience, DESKTOP_SITE_PROFILE_LIMITS.text),
        }
        if (!profile.name && !profile.description && !profile.offering && !profile.audience) return null
        const checked = desktopIntakeSiteProfileSchema.safeParse(profile)
        return checked.success ? checked.data : null
    }
    return null
}
