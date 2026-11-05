'use client'

import { SkillProposalBlock as SkillProposalBlockBase } from '@rerun/ui/chat'
import type { EngineSkillProposal } from '@/lib/engine/types'

export type DesktopSkillProposalBlockProps = {
    proposal: EngineSkillProposal
    pending?: boolean
    onDecide?: (decision: 'accept' | 'dismiss') => void
    onOpenSkill?: () => void
    pinned?: boolean
}

// Port of the chat SkillProposalBlock: same card, same labels. The web card routes "Open skill"
// through the board store; the desktop panel drills in on its own shelf instead.
export function DesktopSkillProposalBlock({ proposal, pending, onDecide, onOpenSkill, pinned = true }: DesktopSkillProposalBlockProps) {
    const decidable = Boolean(onDecide)
    const appliedSlug = proposal.appliedSlug

    return (
        <SkillProposalBlockBase
            pinned={pinned}
            mode={proposal.mode}
            title={proposal.title}
            summary={proposal.summary}
            state={proposal.status}
            count={proposal.instructions.length}
            instructions={proposal.instructions}
            error={proposal.error}
            pending={pending}
            onAccept={decidable ? () => onDecide?.('accept') : undefined}
            onDismiss={decidable ? () => onDecide?.('dismiss') : undefined}
            onOpenSkill={appliedSlug && onOpenSkill ? onOpenSkill : undefined}
        />
    )
}
