import type { EngineSkillProposal } from '@/lib/engine/types'

export type CoworkerSkillProposalSnapshot = {
    availability: 'complete' | 'partial' | 'unavailable'
    proposals: EngineSkillProposal[]
    failedSessions?: number
}

function byNewest(proposals: EngineSkillProposal[]): EngineSkillProposal[] {
    return [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/**
 * null means the panel keeps the rows it already has. A complete snapshot replaces them.
 * A partial snapshot overlays the rows that were read and leaves every other known row in place.
 */
export function applyProposalSnapshot(previous: EngineSkillProposal[], snapshot: CoworkerSkillProposalSnapshot | null): EngineSkillProposal[] | null {
    if (!snapshot || snapshot.availability === 'unavailable') return null
    if (snapshot.availability === 'partial') {
        const merged = new Map(previous.map(proposal => [proposal.id, proposal]))
        for (const proposal of snapshot.proposals) merged.set(proposal.id, proposal)
        return byNewest([...merged.values()])
    }
    return byNewest(snapshot.proposals)
}
