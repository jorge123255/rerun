import type { BrainProposal, BrainProposalStatus } from '@rerun/contracts'

export type DesktopBrainProposalDecision = {
    proposal: BrainProposal
    applied: false
    conflict: boolean
    unchanged: boolean
    pageWrite: {
        slug: string
        title: string
        type: BrainProposal['type']
        content: string
        sources: string[]
        baseHash: string | null
        author: string
        proposalId: string
        force: false
    } | null
}

const BASE = '/api/desktop/brain/proposals'

async function parse<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Company brain proposals could not be opened.')
    return body as T
}

export async function listDesktopBrainProposals(status: BrainProposalStatus = 'proposed', signal?: AbortSignal): Promise<BrainProposal[]> {
    const query = new URLSearchParams({ status })
    const response = await fetch(`${BASE}?${query}`, { cache: 'no-store', signal })
    const body = await parse<{ proposals: BrainProposal[] }>(response)
    return body.proposals
}

export async function countDesktopBrainProposals(signal?: AbortSignal): Promise<number> {
    const response = await fetch(`${BASE}/count`, { cache: 'no-store', signal })
    const body = await parse<{ count: number }>(response)
    return body.count
}

export async function decideDesktopBrainProposal(id: string, decision: 'accept' | 'dismiss', signal?: AbortSignal): Promise<DesktopBrainProposalDecision> {
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/${decision}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
        signal,
    })
    return parse(response)
}
