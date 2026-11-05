import { z } from 'zod'
import { brainPageTypeSchema, brainProposalSchema, type BrainProposalStatus } from '@rerun/contracts'
import { desktopBrainHashSchema, desktopBrainRequestIdSchema, DesktopBrainRequestError } from './brain-pages'

export const desktopBrainProposalViewSchema = brainProposalSchema.extend({ reviewedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expectedPageHash: desktopBrainHashSchema.nullable() })
export const desktopBrainProposalDecisionInputSchema = z.object({
    reviewedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expectedPageHash: desktopBrainHashSchema.nullable(), requestId: desktopBrainRequestIdSchema,
    edits: z.object({ title: z.string().trim().min(1).max(120).optional(), type: brainPageTypeSchema.optional(), content: z.string().min(1).max(60_000).optional() }).strict().optional(),
}).strict()
export const desktopBrainProposalDecisionSchema = z.object({ proposal: desktopBrainProposalViewSchema, applied: z.boolean(), slug: z.string(), requestId: desktopBrainRequestIdSchema })
export type DesktopBrainProposalView = z.infer<typeof desktopBrainProposalViewSchema>
export type DesktopBrainProposalDecision = z.infer<typeof desktopBrainProposalDecisionSchema>
export type DesktopBrainProposalDecisionInput = z.infer<typeof desktopBrainProposalDecisionInputSchema>
const BASE = '/api/desktop/brain/proposals'
async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    if (!response.ok) throw new DesktopBrainRequestError(response.status, response.status === 409 ? 'This proposal or page changed. Review its current version.' : 'Company brain proposals could not be opened.')
    return schema.parse(await response.json())
}
const lifetime = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
export async function listDesktopBrainProposals(status: BrainProposalStatus = 'proposed', signal?: AbortSignal): Promise<DesktopBrainProposalView[]> {
    const response = await fetch(`${BASE}?${new URLSearchParams({ status })}`, { cache: 'no-store', signal: lifetime(signal), redirect: 'error' })
    return (await parse(response, z.object({ proposals: z.array(desktopBrainProposalViewSchema) }))).proposals
}
export async function countDesktopBrainProposals(signal?: AbortSignal): Promise<number> {
    const response = await fetch(`${BASE}/count`, { cache: 'no-store', signal: lifetime(signal), redirect: 'error' })
    return (await parse(response, z.object({ count: z.number().int().nonnegative() }))).count
}
export async function decideDesktopBrainProposal(id: string, decision: 'accept' | 'dismiss', input: DesktopBrainProposalDecisionInput, signal?: AbortSignal): Promise<DesktopBrainProposalDecision> {
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/${decision}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(desktopBrainProposalDecisionInputSchema.parse(input)), cache: 'no-store', signal: lifetime(signal), redirect: 'error',
    })
    const result = await parse(response, desktopBrainProposalDecisionSchema)
    if (result.requestId !== input.requestId || result.proposal.id !== id || result.slug !== result.proposal.slug) throw new Error('The Brain decision response could not be confirmed. Retry the same decision.')
    return result
}
