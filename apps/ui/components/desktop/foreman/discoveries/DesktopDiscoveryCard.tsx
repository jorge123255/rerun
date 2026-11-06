'use client'

import type { ReactNode } from 'react'
import {
    DESKTOP_DISCOVERY_SOURCE_LABELS,
    type DesktopDiscoveryFinding,
    type DesktopDiscoverySource,
} from '@/lib/desktop/foreman-client'
import { GlobeIcon, Package, TargetIcon, UsersIcon, type LucideIcon } from '@/lib/icons'
import { Icon } from '@/components/ui/icon'

export const DISCOVERY_CARD_CLASS = 'relative w-full rounded-xl border border-border bg-card p-3 shadow-lg shadow-black/15'

function Shell({
    icon,
    label,
    source,
    children,
}: {
    icon: LucideIcon
    label: string
    source: DesktopDiscoverySource
    children: ReactNode
}) {
    return (
        <div className={DISCOVERY_CARD_CLASS}>
            <div className="mb-2 flex items-center gap-2">
                <Icon icon={icon} size="xs" />
                <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
                <span className="ml-auto text-[10px] text-muted-foreground/70">{DESKTOP_DISCOVERY_SOURCE_LABELS[source]}</span>
            </div>
            {children}
        </div>
    )
}

export function DesktopDiscoveryCard({ finding }: { finding: DesktopDiscoveryFinding; still?: boolean }) {
    switch (finding.kind) {
        case 'identity':
            return (
                <Shell icon={GlobeIcon} label="Found you" source={finding.source}>
                    <div className="min-w-0">
                        <p className="truncate font-heading text-sm font-medium">{finding.name}</p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">{finding.oneLiner ?? finding.domain}</p>
                        <p className="mt-1 truncate text-[10px] text-muted-foreground/70">{finding.attribution.url}</p>
                    </div>
                </Shell>
            )
        case 'audience':
            return (
                <Shell icon={UsersIcon} label="Who you sell to" source={finding.source}>
                    <p className="text-xs leading-relaxed">{finding.text}</p>
                </Shell>
            )
        case 'products':
            return (
                <Shell icon={Package} label="Products" source={finding.source}>
                    <p className="text-xs leading-relaxed">{finding.items.join(' · ')}</p>
                </Shell>
            )
        case 'competitors':
            return (
                <Shell icon={TargetIcon} label="Competitors" source={finding.source}>
                    <p className="text-xs leading-relaxed">{finding.items.join(' · ')}</p>
                </Shell>
            )
        case 'customers':
            return (
                <Shell icon={UsersIcon} label="Customers" source={finding.source}>
                    <p className="text-xs leading-relaxed">{finding.items.join(' · ')}</p>
                </Shell>
            )
    }
}

export function DesktopDiscoveryUnavailableCard({ source }: { source: DesktopDiscoverySource }) {
    return (
        <Shell icon={GlobeIcon} label="Unavailable" source={source}>
            <p className="text-xs text-muted-foreground">This collector is not available on desktop.</p>
        </Shell>
    )
}
