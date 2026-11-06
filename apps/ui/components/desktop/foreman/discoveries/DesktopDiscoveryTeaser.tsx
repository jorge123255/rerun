'use client'

import {
    DESKTOP_DISCOVERY_SOURCE_LABELS,
    DESKTOP_DISCOVERY_TEASERS,
    type DesktopDiscoverySource,
} from '@/lib/desktop/foreman-client'
import { DISCOVERY_CARD_CLASS } from './DesktopDiscoveryCard'

export function DesktopDiscoveryTeaser({
    source,
    subject,
}: {
    source: DesktopDiscoverySource
    subject: { name: string; domain: string }
}) {
    const line = DESKTOP_DISCOVERY_TEASERS[source](subject)
    return (
        <div className={DISCOVERY_CARD_CLASS}>
            <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">Searching</span>
                <span className="ml-auto text-[10px] text-muted-foreground/70">{DESKTOP_DISCOVERY_SOURCE_LABELS[source]}</span>
            </div>
            <p className="text-xs text-muted-foreground">{line}</p>
        </div>
    )
}
