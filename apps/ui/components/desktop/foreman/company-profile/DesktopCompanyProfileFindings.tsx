'use client'

import type { ReactNode } from 'react'
import { INTAKE_INDUSTRIES, type DesktopCompanyProfileEvidence, type DesktopCompanyProfileProjection } from '@rerun/contracts'
import { Icon } from '@/components/ui/icon'
import { DESKTOP_DISCOVERY_SOURCE_LABELS } from '@/lib/desktop/foreman-client'
import { Building2, GlobeIcon, Package, UsersIcon, type LucideIcon } from '@/lib/icons'
import { DISCOVERY_CARD_CLASS } from '../discoveries/DesktopDiscoveryCard'

function Evidence({ evidence }: { evidence: DesktopCompanyProfileEvidence[] }) {
    if (!evidence.length) return null
    return <details className="mt-2">
        <summary className="cursor-pointer text-[10px] text-muted-foreground/70">Sources</summary>
        <div className="mt-1 space-y-2">{evidence.slice(0, 2).map(item => <div key={item.id}>
            <blockquote className="line-clamp-3 border-l pl-2 text-[10px] leading-relaxed text-muted-foreground">{item.passage}</blockquote>
            <a className="mt-0.5 block truncate text-[10px] text-muted-foreground/70 underline" href={item.url} rel="noreferrer">{item.url}</a>
        </div>)}</div>
    </details>
}

function Card({ icon, label, source, children, evidence }: {
    icon: LucideIcon
    label: string
    source: DesktopCompanyProfileEvidence['source'] | 'profile'
    children: ReactNode
    evidence: DesktopCompanyProfileEvidence[]
}) {
    return <section className={DISCOVERY_CARD_CLASS}>
        <div className="mb-2 flex items-center gap-2">
            <Icon icon={icon} size="xs" />
            <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
            <span className="ml-auto text-[10px] text-muted-foreground/70">{DESKTOP_DISCOVERY_SOURCE_LABELS[source]}</span>
        </div>
        {children}
        <Evidence evidence={evidence} />
    </section>
}

export function DesktopCompanyProfileFindings({ profile, limit }: { profile: DesktopCompanyProfileProjection; limit?: number }) {
    const cards: ReactNode[] = []
    const source = (evidence: DesktopCompanyProfileEvidence[]) => evidence[0]?.source ?? 'profile'
    if (profile.name.value || profile.description.value) cards.push(
        <Card key="identity" icon={GlobeIcon} label="Found you" source={source([...profile.name.evidence, ...profile.description.evidence])} evidence={[...profile.name.evidence, ...profile.description.evidence]}>
            {profile.name.value && <p className="truncate font-heading text-sm font-medium">{profile.name.value}</p>}
            {profile.description.value && <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{profile.description.value}</p>}
        </Card>,
    )
    if (profile.offering.value) cards.push(
        <Card key="offering" icon={Package} label="What you sell" source={source(profile.offering.evidence)} evidence={profile.offering.evidence}>
            <p className="text-xs leading-relaxed">{profile.offering.value}</p>
        </Card>,
    )
    if (profile.audience.value) cards.push(
        <Card key="audience" icon={UsersIcon} label="Who you sell to" source={source(profile.audience.evidence)} evidence={profile.audience.evidence}>
            <p className="text-xs leading-relaxed">{profile.audience.value}</p>
        </Card>,
    )
    if (profile.industry.value) cards.push(
        <Card key="industry" icon={Building2} label="Industry" source={source(profile.industry.evidence)} evidence={profile.industry.evidence}>
            <p className="text-xs leading-relaxed">{INTAKE_INDUSTRIES.find(option => option.value === profile.industry.value)?.label ?? profile.industry.value}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">{profile.industry.origin}{profile.industry.confidence !== null ? ` · ${Math.round(profile.industry.confidence * 100)}% confidence` : ''}</p>
        </Card>,
    )
    return <>{cards.slice(0, limit)}</>
}

export function companyProfileDomain(profile: DesktopCompanyProfileProjection): string {
    const value = profile.companyUrl.value
    if (!value) return 'your company'
    try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./i, '') } catch { return value }
}
