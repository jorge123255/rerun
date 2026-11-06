'use client'
import { Badge } from '@rerun/ui/primitives'
import type { SelfMcpProposal, SelfMcpProposalStatus } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Compact review card, original-style: name, transport · destination, status badge. */
export function SelfMcpReviewCard({ proposal, onOpen, selected }: { proposal: SelfMcpProposal; onOpen?: () => void; selected?: boolean }) {
    const destination = proposal.transport === 'stdio'
        ? proposal.input.command
            ? `stdio · ${proposal.input.command}${proposal.input.args.length ? ` ${proposal.input.args.join(' ')}` : ''}`
            : 'stdio'
        : `${proposal.transport} · ${proposal.input.url ?? ''}`
    return (
        <div className={cn('p-3 border-b border-border space-y-2', selected && 'bg-accent/40')}>
            <div className="flex items-center justify-between gap-2">
                {onOpen ? (
                    <Button variant="ghost" onClick={onOpen}>{proposal.input.name}</Button>
                ) : (
                    <span className="text-sm font-medium">{proposal.input.name}</span>
                )}
                <SelfMcpStatusBadge status={proposal.status} />
            </div>
            <p className="text-xs text-muted-foreground break-all">{destination}</p>
            <p className="text-xs text-muted-foreground">Suggested by your coworker.</p>
        </div>
    )
}

const STATUS_LABELS: Record<SelfMcpProposalStatus, string> = {
    pending: 'Waiting for review',
    claimed: 'Being processed',
    applied: 'Saved',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    uncertain: 'Outcome uncertain',
}

export function SelfMcpStatusBadge({ status }: { status: SelfMcpProposalStatus }) {
    const tone = status === 'applied' ? 'success' : status === 'rejected' || status === 'cancelled' ? 'danger' : status === 'claimed' ? 'warning' : 'brand'
    return <Badge size="xs" fill="soft" tone={tone as 'brand'}>{STATUS_LABELS[status]}</Badge>
}
