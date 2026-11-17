import type { SkillProposalStatus } from './skill-proposal.js'
import { parseHubOutput } from './tool-output.js'

const PINNABLE: SkillProposalStatus[] = ['proposed', 'failed']
const RELEASED_AT_ONCE: SkillProposalStatus[] = ['accepted']

export const RELEASE_DELAY_MS = 2500

type Pinnable = { id: string; status: SkillProposalStatus }

export function isPinnable(status: SkillProposalStatus): boolean {
    return PINNABLE.includes(status)
}

/**
 * A proposal joins the dock while it still needs a decision, and stays there once it has joined:
 * a decided one is released by its own timer instead, so the row reports its outcome where the
 * user is looking. Accepting is the exception: the writing is a background job nobody waits on,
 * so the row is handed back to the transcript on the spot and reports its progress there. One
 * already settled when the conversation opened never joins.
 */
export function nextPinnedIds(pinned: ReadonlySet<string>, proposals: Iterable<Pinnable>): Set<string> {
    const next = new Set<string>()
    for (const proposal of proposals) {
        if (isPinnable(proposal.status) || (pinned.has(proposal.id) && !RELEASED_AT_ONCE.includes(proposal.status))) next.add(proposal.id)
    }
    return next
}

export function settledPinnedIds(pinned: ReadonlySet<string>, proposals: Iterable<Pinnable>): string[] {
    const settled: string[] = []
    for (const proposal of proposals) {
        if (pinned.has(proposal.id) && !isPinnable(proposal.status)) settled.push(proposal.id)
    }
    return settled
}

// The proposal a `skill_propose` call raised, read from the id it returned: the MCP bridge of the CLI
// providers rewrites tool call ids. A call that only merged into a proposal already waiting raised none.
export function skillProposalIdOf(output: unknown): string | null {
    const out = parseHubOutput<{ status?: string; proposalId?: string }>(output)
    return out?.status === 'shown' && out.proposalId ? out.proposalId : null
}
