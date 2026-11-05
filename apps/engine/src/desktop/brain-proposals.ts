import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brainPageTypeSchema, brainProposalInputSchema, type BrainProposal, type BrainPageRef, type BrainPageType } from '@rerun/contracts'
import { textHash } from '../brain/chunks.js'

/** Types shared by the one engine-owned Brain repository and its HTTP/tool adapters. */
export const desktopBrainRequestIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const desktopBrainHashSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const desktopBrainDecisionSchema = z.object({
    reviewedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expectedPageHash: desktopBrainHashSchema.nullable(),
    requestId: desktopBrainRequestIdSchema,
    edits: z.object({ title: z.string().trim().min(1).max(120).optional(), type: brainPageTypeSchema.optional(), content: z.string().min(1).max(60_000).optional() }).strict().optional(),
}).strict()
export const desktopBrainProposalDraftSchema = brainProposalInputSchema.extend({
    agentId: z.string().min(1).max(120), agentName: z.string().min(1).max(120), sessionId: z.string().min(1).max(128),
}).strict()
export type DesktopBrainProposalDraft = z.infer<typeof desktopBrainProposalDraftSchema>
export type DesktopBrainDecisionInput = z.infer<typeof desktopBrainDecisionSchema>
export type DesktopBrainProposalView = BrainProposal & { reviewedFingerprint: string; expectedPageHash: string | null }
export type DesktopBrainDecision = { proposal: DesktopBrainProposalView; applied: boolean; slug: string; requestId: string }
export type DesktopBrainAccess = { signal?: AbortSignal; beforeCommit?: () => Promise<void> | void }
export type DesktopBrainPageFile = { slug: string; title: string; type: BrainPageType; content: string; hash: string; sources: string[]; updatedAt: string; updatedBy: string; unconfirmed: string[] }
export type DesktopBrainSearchResult = { hits: { slug: string; title: string; type: BrainPageType; passages: { heading: string; content: string }[]; score: number }[]; related: BrainPageRef[] }
export function desktopBrainPageHash(page: { title: string; type: string; content: string }): string {
    return textHash(`${page.title.trim()}\n${page.type}\n${page.content.trim()}`)
}
/** Every displayed/reviewed field is bound; unlike the original dedupe hash this is case-sensitive. */
export function desktopBrainProposalFingerprint(proposal: DesktopBrainProposalDraft): string {
    return createHash('sha256').update(JSON.stringify([
        proposal.agentId, proposal.agentName, proposal.sessionId, proposal.slug, proposal.title,
        proposal.headline, proposal.highlights, proposal.type, proposal.content, proposal.reason,
        proposal.sources, proposal.baseHash,
    ])).digest('hex')
}
export function desktopBrainTerms(query: string): string[] {
    return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(term => term.length > 1))].slice(0, 20)
}
