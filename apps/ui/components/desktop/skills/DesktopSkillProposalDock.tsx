'use client'

import { AnimatePresence, motion } from 'motion/react'
import { isPinnable } from '@rerun/contracts'
import type { EngineSkillProposal } from '@/lib/engine/types'
import { DesktopSkillProposalBlock } from './DesktopSkillProposalBlock'

/** Original SkillProposalDock motion and placement, bound to this desktop conversation. */
export function DesktopSkillProposalDock({ proposals, pendingId, onDecide, onOpenSkill }: {
    proposals: EngineSkillProposal[]; pendingId: string | null
    onDecide: (id: string, decision: 'accept' | 'dismiss') => void
    onOpenSkill: (slug: string) => void
}) {
    return <div className="max-h-[34vh] overflow-y-auto"><AnimatePresence initial={false}>
        {proposals.map(proposal => <motion.div key={proposal.id} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }} className="overflow-hidden">
            <div className="pb-2"><DesktopSkillProposalBlock proposal={proposal} pending={pendingId === proposal.id}
                onDecide={isPinnable(proposal.status) ? decision => onDecide(proposal.id, decision) : undefined}
                onOpenSkill={proposal.appliedSlug ? () => onOpenSkill(proposal.appliedSlug!) : undefined} /></div>
        </motion.div>)}
    </AnimatePresence></div>
}
