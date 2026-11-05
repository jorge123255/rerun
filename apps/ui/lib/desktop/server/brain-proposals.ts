import 'server-only'
import { brainPageTypeSchema, brainProposalStatusSchema, type BrainProposal, type BrainProposalStatus } from '@rerun/contracts'
import { z } from 'zod'
import {
    countDesktopBrainProposals,
    decideDesktopBrainProposal,
    DesktopBrainProposalError,
    listDesktopBrainProposals,
    resolveDesktopBrainEngineFromDataRoot,
    type DesktopBrainAccess,
    type DesktopBrainDecision,
} from '../../../../engine/src/desktop/brain-proposals'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'

// Workspace company-brain proposals. The engine directory comes from the desktop data root.
// Requests cannot choose a root, an engine id, or a private memory. Accepting does not write a page.

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

function failure(error: unknown): never {
    if (error instanceof DesktopHttpError) throw error
    if (error instanceof DesktopBrainProposalError) throw new DesktopHttpError(error.status, error.message)
    if (isAbort(error)) throw new DesktopHttpError(499, 'This request was cancelled.')
    throw new DesktopHttpError(500, 'Company brain proposals could not be opened.')
}

async function engineDirectory(runtime: DesktopRuntime, signal?: AbortSignal): Promise<string> {
    try { return await resolveDesktopBrainEngineFromDataRoot(runtime.dataRoot, signal) }
    catch (error) { failure(error) }
}

export async function listDesktopBrainProposalViews(runtime: DesktopRuntime, status?: BrainProposalStatus, access?: DesktopBrainAccess): Promise<BrainProposal[]> {
    try { return await listDesktopBrainProposals(await engineDirectory(runtime, access?.signal), status, access?.signal) }
    catch (error) { failure(error) }
}

export async function countOpenDesktopBrainProposals(runtime: DesktopRuntime, access?: DesktopBrainAccess): Promise<number> {
    try { return await countDesktopBrainProposals(await engineDirectory(runtime, access?.signal), access?.signal) }
    catch (error) { failure(error) }
}

export function desktopBrainProposalStatus(value: string | null): BrainProposalStatus | undefined {
    if (!value) return 'proposed'
    const parsed = brainProposalStatusSchema.safeParse(value)
    if (!parsed.success) throw new DesktopHttpError(400, 'That proposal list is not available.')
    return parsed.data
}

export async function decideDesktopBrainProposalView(
    runtime: DesktopRuntime,
    id: string,
    decision: 'accept' | 'dismiss',
    body: unknown,
    access?: DesktopBrainAccess,
): Promise<DesktopBrainDecision> {
    const edits = decision === 'accept' ? acceptEdits(body) : {}
    try { return await decideDesktopBrainProposal(await engineDirectory(runtime, access?.signal), id, decision, edits, access) }
    catch (error) { failure(error) }
}

// Same optional edits as brainProposalAcceptSchema. decidedBy and every other key are rejected:
// this Mac sets the author itself.
const acceptBody = z.strictObject({
    content: z.string().min(1).max(60_000).optional(),
    title: z.string().min(1).max(120).optional(),
    type: brainPageTypeSchema.optional(),
})

function acceptEdits(body: unknown): { title?: string; type?: BrainProposal['type']; content?: string } {
    const parsed = acceptBody.safeParse(body ?? {})
    if (!parsed.success) throw new DesktopHttpError(400, 'The decision author is set by this Mac.')
    return parsed.data
}
