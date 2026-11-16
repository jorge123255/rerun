'use client'

import { useEffect, useState } from 'react'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { Icon } from '@/components/ui/icon'
import { readDesktopIntakeSiteProfile } from '@/lib/desktop/foreman-intake/client'
import type { DesktopIntakeSiteProfile as SiteProfile } from '@/lib/desktop/foreman-intake/site-profile'
import type { DesktopForemanIntakeController } from '@/lib/desktop/foreman-intake'
import { GlobeIcon } from '@/lib/icons'
import { DISCOVERY_CARD_CLASS } from '../discoveries/DesktopDiscoveryCard'

function domainOf(website: string): string {
    try { return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./i, '') } catch { return website }
}

function Line({ label, value }: { label: string; value: string | null }) {
    if (!value) return null
    return <div>
        <dt className="text-[10px] font-medium text-muted-foreground">{label}</dt>
        <dd className="line-clamp-3 text-xs leading-relaxed">{value}</dd>
    </div>
}

/**
 * What the intake read on the person's website, in the card style of the original board findings.
 * Shown as soon as the read finishes and again when the saved intake is reopened, and only while
 * the website in the answers is still the one that was read. The text is page content: it is
 * rendered as plain text and labelled as coming from their page.
 */
export function DesktopIntakeSiteProfile({ chat, intake, active = true, read = readDesktopIntakeSiteProfile }: {
    chat: DesktopForemanChatRef
    intake: Pick<DesktopForemanIntakeController, 'draft' | 'siteRead' | 'restored' | 'finished'>
    active?: boolean
    read?: (chat: DesktopForemanChatRef, signal?: AbortSignal) => Promise<SiteProfile | null>
}) {
    const website = intake.draft.websiteSkipped ? '' : intake.draft.companyUrl.trim()
    const [found, setFound] = useState<{ key: string; profile: SiteProfile | null } | null>(null)
    const key = JSON.stringify([chat.workspaceId, chat.chatId])
    const hasWebsite = !!website
    const ready = intake.siteRead === 'ready'
    useEffect(() => {
        if (!active || !intake.restored || !hasWebsite) return
        const controller = new AbortController()
        read({ workspaceId: chat.workspaceId, chatId: chat.chatId }, controller.signal)
            .then(profile => { if (!controller.signal.aborted) setFound({ key, profile }) })
            // The card is a convenience: when it cannot be read the questions carry on without it.
            .catch(() => {})
        return () => controller.abort()
    }, [read, key, chat.workspaceId, chat.chatId, active, intake.restored, hasWebsite, ready])

    const profile = found?.key === key ? found.profile : null
    if (intake.finished || !intake.restored || !profile || profile.website !== website) return null
    return (
        <section data-intake-site-profile aria-label="Read from your website" className={`${DISCOVERY_CARD_CLASS} pointer-events-auto mx-auto max-w-[22rem] text-left`}>
            <div className="mb-2 flex items-center gap-2">
                <Icon icon={GlobeIcon} size="xs" />
                <span className="text-[11px] font-medium text-muted-foreground">Read from your website</span>
                <span className="ml-auto truncate text-[10px] text-muted-foreground/70">{domainOf(profile.website)}</span>
            </div>
            {profile.name && <p className="truncate font-heading text-sm font-medium">{profile.name}</p>}
            <dl className="mt-1 space-y-1.5">
                <Line label="About" value={profile.description} />
                <Line label="What you sell" value={profile.offering} />
                <Line label="Who you sell to" value={profile.audience} />
            </dl>
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">Your Chief of Staff starts from this. If something is wrong, say so in the chat and your answer wins.</p>
        </section>
    )
}
