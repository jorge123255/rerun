'use client'

import type { ReactNode } from 'react'
import { COMPANY_BRIEF_NO_SOURCES, DESKTOP_FOREMAN_SOURCE_LABELS, type CompanyBriefAttempt, type DesktopForemanFinding } from '@rerun/contracts'

const TAG = /(\[(?:dns|stack|site|search|registry|linkedin|google|catalog)(?::[\w.-]+)?\])/g

// Review sits beside the board. It does not replace the chat, and it does not fetch on mount.
export function DesktopCompanyBriefReview({
    attempt,
    findings,
    draft,
    selectedClaimIds,
    notice,
    busy = false,
    onDraft,
    onEdit,
    onDismiss,
    onRetry,
    onToggleClaim,
    onHandoff,
}: {
    attempt: CompanyBriefAttempt | null
    findings: DesktopForemanFinding[]
    draft: string
    selectedClaimIds: string[]
    notice: string | null
    busy?: boolean
    onDraft: (brief: string) => void
    onEdit: () => void
    onDismiss: () => void
    onRetry: () => void
    onToggleClaim: (claimId: string) => void
    onHandoff: () => void
}) {
    if (!attempt) return null
    const links = attempt.result?.claims.flatMap(claim => claim.links) ?? []
    return (
        <aside aria-label="Company brief" className="pointer-events-auto absolute bottom-4 left-4 z-20 flex max-h-[min(32rem,70vh)] w-80 flex-col gap-3 overflow-auto rounded-xl border border-border bg-card p-3 shadow-lg shadow-black/15">
            <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium">Company brief</h2>
                <span className="ml-auto text-[10px] text-muted-foreground/70">{DESKTOP_FOREMAN_SOURCE_LABELS.synthesis}</span>
            </div>
            {notice ? <p className="text-xs text-destructive" role="alert">{notice}</p> : null}
            {attempt.error?.message === COMPANY_BRIEF_NO_SOURCES ? <p className="text-xs text-muted-foreground">{COMPANY_BRIEF_NO_SOURCES}</p> : null}
            <ul className="flex flex-col gap-2">
                {findings.map((finding, index) => <li key={`${finding.kind}-${index}`}><FindingLine finding={finding} /></li>)}
            </ul>
            {attempt.result ? <BriefText brief={attempt.result.brief} links={links} /> : null}
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                Edit
                <textarea className="min-h-24 rounded-md border border-border bg-background p-2 text-xs text-foreground" value={draft} onChange={event => onDraft(event.target.value)} />
            </label>
            {attempt.result?.claims.map(claim => (
                <label key={claim.id} className="flex items-start gap-2 text-xs">
                    <input type="checkbox" checked={selectedClaimIds.includes(claim.id)} onChange={() => onToggleClaim(claim.id)} />
                    <span>{claim.text}</span>
                </label>
            ))}
            <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-md border border-border px-2 py-1 text-xs" disabled={busy} onClick={onEdit}>Edit</button>
                <button type="button" className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground" disabled={busy} onClick={onDismiss}>Dismiss</button>
                <button type="button" className="rounded-md border border-border px-2 py-1 text-xs" disabled={busy} onClick={onRetry}>Retry</button>
                <button type="button" className="rounded-md border border-border px-2 py-1 text-xs" disabled={busy || selectedClaimIds.length === 0} onClick={onHandoff}>Propose to Company Brain</button>
            </div>
        </aside>
    )
}

function FindingLine({ finding }: { finding: DesktopForemanFinding }) {
    const label = finding.kind === 'identity' ? 'Found you' : finding.kind === 'audience' ? 'Who you sell to' : finding.kind === 'products' ? 'Products' : finding.kind === 'competitors' ? 'Competitors' : 'Customers'
    const text = finding.kind === 'identity' ? finding.name : finding.kind === 'audience' ? finding.text : finding.items.join(' · ')
    const detail = finding.kind === 'identity' ? finding.oneLiner ?? finding.domain : null
    return (
        <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
                <span className="ml-auto text-[10px] text-muted-foreground/70">{DESKTOP_FOREMAN_SOURCE_LABELS[finding.source]}</span>
            </div>
            <p className="truncate text-sm font-medium">{text}</p>
            {detail ? <p className="line-clamp-2 text-xs text-muted-foreground">{detail}</p> : null}
            <a className="mt-1 block truncate text-[10px] text-muted-foreground/70 underline" href={finding.attribution.url} rel="noreferrer">{finding.attribution.url}</a>
        </div>
    )
}

function BriefText({ brief, links }: { brief: string; links: { tag: string; url: string }[] }) {
    const urls = new Map(links.map(link => [link.tag, link.url]))
    return (
        <div>
            {brief.split('\n').map((line, index) => {
                if (!line) return null
                if (line.startsWith('## ')) return <h3 key={index} className="mt-3 text-sm font-medium">{line.slice(3)}</h3>
                return <p key={index} className="text-xs leading-relaxed">{linkLine(line, urls)}</p>
            })}
        </div>
    )
}

function linkLine(line: string, urls: Map<string, string>): ReactNode[] {
    return line.split(TAG).map((part, index) => {
        const tag = part.startsWith('[') && part.endsWith(']') ? part.slice(1, -1) : null
        const url = tag ? urls.get(tag) : undefined
        if (!tag || !url) return <span key={index}>{part}</span>
        return <a key={index} href={url} rel="noreferrer">{part}</a>
    })
}
