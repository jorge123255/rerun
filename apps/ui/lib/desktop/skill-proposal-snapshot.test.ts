import { describe, expect, it } from 'vitest'
import type { EngineSkillProposal } from '@/lib/engine/types'
import { applyProposalSnapshot, type CoworkerSkillProposalSnapshot } from './skill-proposal-snapshot'

function row(id: string, createdAt: string, status: EngineSkillProposal['status'] = 'proposed'): EngineSkillProposal {
    return {
        id,
        sessionId: 'session',
        toolCallId: `tc-${id}`,
        mode: 'create',
        slug: null,
        title: id,
        summary: id,
        instructions: [],
        status,
        appliedSlug: null,
        error: null,
        createdAt,
    }
}

function snapshot(availability: CoworkerSkillProposalSnapshot['availability'], proposals: EngineSkillProposal[]): CoworkerSkillProposalSnapshot {
    return { availability, proposals }
}

describe('applyProposalSnapshot', () => {
    const previous = [row('keep', '2026-11-04T00:00:02.000Z'), row('old', '2026-11-04T00:00:01.000Z')]

    it('keeps known rows when the read is missing or unavailable', () => {
        expect(applyProposalSnapshot(previous, null)).toBeNull()
        expect(applyProposalSnapshot(previous, snapshot('unavailable', []))).toBeNull()
    })

    it('replaces known rows when the snapshot is complete', () => {
        const next = applyProposalSnapshot(previous, snapshot('complete', [row('new', '2026-11-04T00:00:03.000Z')]))
        expect(next?.map(proposal => proposal.id)).toEqual(['new'])
    })

    it('overlays a partial read without dropping rows the failed session would have carried', () => {
        const next = applyProposalSnapshot(previous, snapshot('partial', [row('keep', '2026-11-04T00:00:02.000Z', 'accepted'), row('fresh', '2026-11-04T00:00:04.000Z')]))
        expect(next?.map(proposal => proposal.id)).toEqual(['fresh', 'keep', 'old'])
        expect(next?.find(proposal => proposal.id === 'keep')?.status).toBe('accepted')
    })
})
