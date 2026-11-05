import { z } from 'zod'
import { brainConfirmSectionsSchema, brainPageWriteSchema, brainPageResponseSchema, brainPagesListSchema, brainRevisionContentSchema, brainSlugSchema, type BrainPage, type BrainPageType, type BrainPageSummary, type BrainRevision } from '@rerun/contracts'

export type BrainPageInput = { title: string; type: BrainPageType; content: string; sources: string[]; baseHash: string | null }
export type BrainPageDetail = { page: BrainPage; revisions: BrainRevision[] }
export type BrainWriteResult = { ok: true; detail: BrainPageDetail } | { ok: false; conflict: boolean; error: string; uncertain?: boolean }
export type BrainDeleteResult = { ok: true } | { ok: false; conflict: boolean; error: string; uncertain?: boolean }
export const desktopBrainRequestIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const desktopBrainHashSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const desktopBrainPageInputSchema = brainPageWriteSchema.omit({ author: true }).extend({ title: brainPageWriteSchema.shape.title.trim().min(1), baseHash: desktopBrainHashSchema.nullable() }).strict()
export const desktopBrainSaveSchema = desktopBrainPageInputSchema.extend({ requestId: desktopBrainRequestIdSchema }).strict()
export const desktopBrainRestoreSchema = z.object({ expectedHash: desktopBrainHashSchema, requestId: desktopBrainRequestIdSchema }).strict()
export const desktopBrainConfirmSchema = brainConfirmSectionsSchema.extend({ expectedHash: desktopBrainHashSchema, requestId: desktopBrainRequestIdSchema }).strict()
export const desktopBrainRevisionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const DESKTOP_BRAIN_BODY_MAX_BYTES = 300_000
export const DESKTOP_BRAIN_RESPONSE_MAX_BYTES = 2_000_000
export type DesktopBrainOverview = { pages: BrainPageSummary[]; openProposals: number }
export type DesktopBrainPagesActions = {
    load(signal?: AbortSignal): Promise<DesktopBrainOverview>
    readPage(slug: string, signal?: AbortSignal): Promise<BrainPageDetail | null>
    savePage(slug: string, input: BrainPageInput, requestId: string, signal?: AbortSignal): Promise<BrainWriteResult>
    deletePage(slug: string, expectedHash: string, requestId: string, signal?: AbortSignal): Promise<BrainDeleteResult>
    readRevision(slug: string, revisionId: string, signal?: AbortSignal): Promise<{ revision: BrainRevision; content: string } | null>
    revertPage(slug: string, revisionId: string, expectedHash: string, requestId: string, signal?: AbortSignal): Promise<BrainWriteResult>
    confirmSections(slug: string, headings: string[] | null, expectedHash: string, requestId: string, signal?: AbortSignal): Promise<BrainWriteResult>
}
export class DesktopBrainRequestError extends Error {
    constructor(readonly status: number, message: string) { super(message); this.name = 'DesktopBrainRequestError' }
}
const pagePath = (slug: string) => `/${encodeURIComponent(brainSlugSchema.parse(slug))}`
const revisionPath = (id: string) => encodeURIComponent(desktopBrainRevisionIdSchema.parse(id))
async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/api/desktop/brain/pages${path}`, { method, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    if (!response.ok) throw new DesktopBrainRequestError(response.status, response.status === 409 ? 'This page changed. Reload it before applying your change.' : response.status === 404 ? 'Brain page or revision not found.' : 'Brain request failed. Try again.')
    return schema.parse(await response.json())
}
function failure(error: unknown): { ok: false; conflict: boolean; error: string; uncertain: boolean } {
    // Gateway/storage failures may have arrived after commit. The exact request must be retried.
    return { ok: false, conflict: error instanceof DesktopBrainRequestError && error.status === 409, error: error instanceof Error ? error.message : 'Brain request failed.', uncertain: !(error instanceof DesktopBrainRequestError) || error.status >= 500 || error.status === 499 }
}
async function write(action: () => Promise<BrainPageDetail>): Promise<BrainWriteResult> {
    try { return { ok: true, detail: await action() } }
    catch (error) { return failure(error) }
}
async function nullable<T>(action: () => Promise<T>): Promise<T | null> {
    try { return await action() } catch (error) { if (error instanceof DesktopBrainRequestError && error.status === 404) return null; throw error }
}
export function createDesktopBrainPagesActions(countOpenProposals: (signal?: AbortSignal) => Promise<number>): DesktopBrainPagesActions {
    return {
        async load(signal) {
            const [list, openProposals] = await Promise.all([request('', brainPagesListSchema, 'GET', undefined, signal), countOpenProposals(signal)])
            if (!Number.isSafeInteger(openProposals) || openProposals < 0) throw new Error('Invalid Brain proposal count.')
            return { pages: list.pages, openProposals }
        },
        readPage: (slug, signal) => nullable(() => request(pagePath(slug), brainPageResponseSchema, 'GET', undefined, signal)),
        savePage: (slug, input, requestId, signal) => write(() => request(pagePath(slug), brainPageResponseSchema, 'PUT', desktopBrainSaveSchema.parse({ ...input, requestId }), signal)),
        async deletePage(slug, expectedHash, requestId, signal) {
            try { return await request(pagePath(slug), z.object({ ok: z.literal(true) }), 'DELETE', desktopBrainRestoreSchema.parse({ expectedHash, requestId }), signal) }
            catch (error) { return failure(error) }
        },
        readRevision: (slug, id, signal) => nullable(() => request(`${pagePath(slug)}/revisions/${revisionPath(id)}`, brainRevisionContentSchema, 'GET', undefined, signal)),
        revertPage: (slug, id, expectedHash, requestId, signal) => write(() => request(`${pagePath(slug)}/revert/${revisionPath(id)}`, brainPageResponseSchema, 'POST', desktopBrainRestoreSchema.parse({ expectedHash, requestId }), signal)),
        confirmSections: (slug, headings, expectedHash, requestId, signal) => write(() => request(`${pagePath(slug)}/confirm`, brainPageResponseSchema, 'POST', desktopBrainConfirmSchema.parse({ headings, expectedHash, requestId }), signal)),
    }
}
