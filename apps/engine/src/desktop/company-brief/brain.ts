import { COMPANY_BRIEF_AGENT_ID, COMPANY_BRIEF_AGENT_NAME, COMPANY_BRIEF_PROPOSAL_REASON } from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { createDesktopBrainPagesStore } from '../brain-pages.js'
import type { DesktopBrainProposalDraft } from '../brain-proposals.js'
import type { CompanyBriefPagePlan } from './ground.js'

type DesktopBrainPagesStore = ReturnType<typeof createDesktopBrainPagesStore>

export type CompanyBriefBrainPage = { hash: string; title: string; content: string }
export type CompanyBriefProposalRecord = { status: 'proposed' | 'updated' | 'duplicate'; id: string; slug: string; fingerprint: string }
export type CompanyBriefBrain = {
    readPage(slug: string): Promise<CompanyBriefBrainPage | null>
    openProposal(slug: string): Promise<{ id: string } | null>
    propose(draft: DesktopBrainProposalDraft): Promise<CompanyBriefProposalRecord>
}

export function bindDesktopCompanyBriefBrain(store: DesktopBrainPagesStore): CompanyBriefBrain {
    return {
        async readPage(slug) {
            try {
                const detail = await store.readPage(slug)
                return { hash: detail.page.hash, title: detail.page.title, content: detail.page.content }
            } catch (error) {
                if (error instanceof HttpError && error.status === 404) return null
                throw error
            }
        },
        async openProposal(slug) {
            const rows = await store.listProposals('proposed')
            const open = rows.find(row => row.agentId === COMPANY_BRIEF_AGENT_ID && row.slug === slug)
            return open ? { id: open.id } : null
        },
        async propose(draft) {
            const result = await store.propose(draft)
            return { status: result.status, id: result.proposal.id, slug: result.proposal.slug, fingerprint: result.proposal.reviewedFingerprint }
        },
    }
}

export function companyBriefProposalDraft(page: CompanyBriefPagePlan, input: { chatId: string; baseHash: string | null }): DesktopBrainProposalDraft {
    return {
        agentId: COMPANY_BRIEF_AGENT_ID,
        agentName: COMPANY_BRIEF_AGENT_NAME,
        sessionId: input.chatId,
        slug: page.slug,
        title: page.title,
        headline: page.headline,
        highlights: page.highlights,
        type: page.type,
        content: page.content,
        reason: COMPANY_BRIEF_PROPOSAL_REASON,
        sources: page.sources,
        baseHash: input.baseHash,
    }
}
