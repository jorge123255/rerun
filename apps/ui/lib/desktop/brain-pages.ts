import { z } from 'zod'
import { brainConfirmSectionsSchema, brainPageWriteSchema, brainPageResponseSchema, brainPagesListSchema, brainRevisionContentSchema, brainRevisionSchema, brainSlugSchema, type BrainPage, type BrainPageType, type BrainPageSummary, type BrainRevision } from '@rerun/contracts'

export type BrainPageInput = { title: string; type: BrainPageType; content: string; sources: string[]; baseHash: string | null }
export type BrainPageDetail = { page: BrainPage; revisions: BrainRevision[] }
export type BrainWriteResult = { ok: true; detail: BrainPageDetail } | { ok: false; conflict: boolean; error: string }
export const desktopBrainPageInputSchema = brainPageWriteSchema.omit({ author: true }).extend({ title: brainPageWriteSchema.shape.title.trim().min(1), baseHash: z.string().regex(/^[a-f0-9]{32}$/).nullable() }).strict()
export const desktopBrainRestoreSchema = z.object({ expectedHash: z.string().regex(/^[a-f0-9]{32}$/) }).strict()
export const desktopBrainRevisionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const DESKTOP_BRAIN_BODY_MAX_BYTES = 300_000
export const DESKTOP_BRAIN_RESPONSE_MAX_BYTES = 2_000_000
export type DesktopBrainPagesActions = {
    listBrainPagesAction(): Promise<BrainPageSummary[]>
    readBrainPageAction(slug: string): Promise<BrainPageDetail>
    saveBrainPageAction(slug: string, input: BrainPageInput): Promise<BrainWriteResult>
    deleteBrainPageAction(slug: string): Promise<{ ok: boolean; error?: string }>
    listBrainRevisionsAction(slug: string): Promise<BrainRevision[]>
    readBrainRevisionAction(slug: string, revisionId: string): Promise<{ revision: BrainRevision; content: string }>
    revertBrainPageAction(slug: string, revisionId: string, expectedHash: string): Promise<BrainWriteResult>
    confirmBrainSectionsAction(slug: string, headings: string[] | null): Promise<BrainWriteResult>
}
export class DesktopBrainRequestError extends Error {
    constructor(readonly status: number, message: string) { super(message); this.name = 'DesktopBrainRequestError' }
}
const pagePath = (slug: string) => `/${encodeURIComponent(brainSlugSchema.parse(slug))}`
const revisionPath = (id: string) => encodeURIComponent(desktopBrainRevisionIdSchema.parse(id))
async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`/api/desktop/brain/pages${path}`, { method, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20_000),
        ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    if (!response.ok) throw new DesktopBrainRequestError(response.status, response.status === 409 ? 'This page changed. Reload it before applying your change.' : response.status === 404 ? 'Brain page or revision not found.' : 'Brain request failed. Try again.')
    return schema.parse(await response.json())
}
async function write(action: () => Promise<BrainPageDetail>): Promise<BrainWriteResult> {
    try { return { ok: true, detail: await action() } }
    catch (error) { return { ok: false, conflict: error instanceof DesktopBrainRequestError && error.status === 409, error: error instanceof Error ? error.message : 'Brain request failed.' } }
}
export const desktopBrainPagesActions: DesktopBrainPagesActions = {
    listBrainPagesAction: async () => (await request('', brainPagesListSchema)).pages,
    readBrainPageAction: slug => request(pagePath(slug), brainPageResponseSchema),
    saveBrainPageAction: (slug, input) => write(() => request(pagePath(slug), brainPageResponseSchema, 'PUT', desktopBrainPageInputSchema.parse(input))),
    deleteBrainPageAction: async slug => {
        try { await request(pagePath(slug), z.object({ ok: z.literal(true) }), 'DELETE'); return { ok: true } }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not delete the page.' } }
    },
    listBrainRevisionsAction: async slug => (await request(`${pagePath(slug)}/revisions`, z.object({ revisions: z.array(brainRevisionSchema) }))).revisions,
    readBrainRevisionAction: (slug, id) => request(`${pagePath(slug)}/revisions/${revisionPath(id)}`, brainRevisionContentSchema),
    revertBrainPageAction: (slug, id, expectedHash) => write(() => request(`${pagePath(slug)}/revert/${revisionPath(id)}`, brainPageResponseSchema, 'POST', desktopBrainRestoreSchema.parse({ expectedHash }))),
    confirmBrainSectionsAction: (slug, headings) => write(() => request(`${pagePath(slug)}/confirm`, brainPageResponseSchema, 'POST', brainConfirmSectionsSchema.strict().parse({ headings }))),
}

export type DesktopBrainOverview = { available: true; pages: BrainPageSummary[]; openProposals: number }
export function createDesktopBrainPagesActions(countOpenProposals: () => Promise<number>): DesktopBrainPagesActions & { loadBrainAction(): Promise<DesktopBrainOverview> } {
    return { ...desktopBrainPagesActions, async loadBrainAction() {
        const [pages, openProposals] = await Promise.all([desktopBrainPagesActions.listBrainPagesAction(), countOpenProposals()])
        if (!Number.isSafeInteger(openProposals) || openProposals < 0) throw new Error('Invalid Brain proposal count.')
        return { available: true, pages, openProposals }
    } }
}
