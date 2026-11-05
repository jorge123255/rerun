'use client'

import { isPinnable } from '@rerun/contracts'
import type { EngineSkillProposal } from '@/lib/engine/types'
import { DesktopSkillProposalBlock } from './DesktopSkillProposalBlock'

export type DesktopSkillProposalReviewProps = {
    pinned: EngineSkillProposal[]
    pendingId: string | null
    onDecide: (proposalId: string, decision: 'accept' | 'dismiss') => void
    onOpenSkill?: (slug: string) => void
}

// The proposal review of one coworker, pinned above the shelf the way the web docks proposals above
// the composer: what still waits on the user, decided right there. The parent owns the polling hook
// so it can refresh the shelf when a proposal lands. A row the engine is writing (accepted) shows
// the spinner without decision buttons; only proposed/failed rows can be decided.
export function DesktopSkillProposalReview({ pinned, pendingId, onDecide, onOpenSkill }: DesktopSkillProposalReviewProps) {
    if (pinned.length === 0) return null

    return (
        <div className="border-b border-border px-3 py-2">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Proposed changes</p>
            <div className="flex flex-col gap-1.5">
                {pinned.map(proposal => (
                    <DesktopSkillProposalBlock
                        key={proposal.id}
                        proposal={proposal}
                        pending={pendingId === proposal.id || proposal.status === 'accepted'}
                        onDecide={isPinnable(proposal.status) ? decision => onDecide(proposal.id, decision) : undefined}
                        onOpenSkill={onOpenSkill && proposal.appliedSlug ? () => onOpenSkill(proposal.appliedSlug!) : undefined}
                    />
                ))}
            </div>
        </div>
    )
}
