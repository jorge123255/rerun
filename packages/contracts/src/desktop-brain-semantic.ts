import { z } from 'zod'

export const DESKTOP_BRAIN_SEMANTIC_BATCH_MAX = 16
export const DESKTOP_BRAIN_SEMANTIC_QUERY_MAX = 8_192
export const DESKTOP_BRAIN_SEMANTIC_PASSAGES_PER_PAGE = 2
export const DESKTOP_BRAIN_SEMANTIC_RELATED_MAX = 8
export const DESKTOP_BRAIN_SEMANTIC_RRF_K = 60

const slug = z.string().trim().min(1).max(128)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/)
const pageType = z.enum(['company', 'offering', 'market', 'team', 'voice', 'stack', 'priorities', 'customer', 'competitor', 'person', 'product', 'decision', 'note'])

export const desktopBrainSemanticBackendSchema = z.strictObject({
    model: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(50),
    dimensions: z.number().int().positive().max(8_192),
    revision: z.string().uuid(),
})
export type DesktopBrainSemanticBackend = z.infer<typeof desktopBrainSemanticBackendSchema>

export const desktopBrainSemanticPageSchema = z.strictObject({
    slug,
    title: z.string().trim().min(1).max(500),
    type: pageType,
    hash: z.string().regex(/^[a-f0-9]{32}$/),
    content: z.string().max(512_000),
    sources: z.array(z.string().max(2_000)).max(100),
    unconfirmed: z.array(z.string().max(500)).max(100),
    links: z.array(slug).max(1_000),
    updatedAt: z.string().max(100),
    updatedBy: z.string().max(200),
})
export type DesktopBrainSemanticPage = z.infer<typeof desktopBrainSemanticPageSchema>

export const desktopBrainSemanticChunkSchema = z.strictObject({
    id: z.string().uuid(),
    slug,
    heading: z.string().max(500),
    ordinal: z.number().int().nonnegative(),
    content: z.string().min(1).max(2_000),
    textHash: z.string().regex(/^[a-f0-9]{32}$/),
    text: z.string().min(1).max(4_000),
})
export type DesktopBrainSemanticChunk = z.infer<typeof desktopBrainSemanticChunkSchema>

export const desktopBrainSemanticIndexEntrySchema = z.strictObject({
    chunk: desktopBrainSemanticChunkSchema,
    pageHash: desktopBrainSemanticPageSchema.shape.hash,
    backendFingerprint: hex64,
    vector: z.array(z.number().finite()).min(1).max(8_192),
})
export type DesktopBrainSemanticIndexEntry = z.infer<typeof desktopBrainSemanticIndexEntrySchema>

export const desktopBrainSemanticPendingSchema = z.strictObject({
    chunk: desktopBrainSemanticChunkSchema,
    pageHash: desktopBrainSemanticPageSchema.shape.hash,
    backendFingerprint: hex64,
    attempts: z.number().int().nonnegative().max(3),
})
export type DesktopBrainSemanticPending = z.infer<typeof desktopBrainSemanticPendingSchema>

export const desktopBrainSemanticIndexStatusSchema = z.strictObject({
    mode: z.enum(['ready', 'partial', 'keyword-only', 'unavailable', 'invalid']),
    backend: desktopBrainSemanticBackendSchema.nullable(),
    indexed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    message: z.string().max(500),
})
export type DesktopBrainSemanticIndexStatus = z.infer<typeof desktopBrainSemanticIndexStatusSchema>

export const desktopBrainSemanticPassageSchema = z.strictObject({ heading: z.string(), content: z.string() })
export const desktopBrainSemanticHitSchema = z.strictObject({
    slug,
    title: z.string(),
    type: pageType,
    passages: z.array(desktopBrainSemanticPassageSchema).max(DESKTOP_BRAIN_SEMANTIC_PASSAGES_PER_PAGE),
    score: z.number().finite(),
})
export type DesktopBrainSemanticHit = z.infer<typeof desktopBrainSemanticHitSchema>
export const desktopBrainSemanticRelatedSchema = z.strictObject({ slug, title: z.string() })
export const desktopBrainSemanticSearchResultSchema = z.strictObject({
    hits: z.array(desktopBrainSemanticHitSchema).max(10),
    related: z.array(desktopBrainSemanticRelatedSchema).max(DESKTOP_BRAIN_SEMANTIC_RELATED_MAX),
    index: desktopBrainSemanticIndexStatusSchema,
})
export type DesktopBrainSemanticSearchResult = z.infer<typeof desktopBrainSemanticSearchResultSchema>
export type DesktopBrainSemanticKeywordResult = { hits: DesktopBrainSemanticHit[]; related: Array<{ slug: string; title: string }> }

export const desktopBrainSemanticSearchInputSchema = z.strictObject({
    query: z.string().trim().min(1).max(DESKTOP_BRAIN_SEMANTIC_QUERY_MAX),
    limit: z.number().int().positive().max(10).default(5),
})
export type DesktopBrainSemanticSearchInput = z.infer<typeof desktopBrainSemanticSearchInputSchema>

export type DesktopBrainSemanticEmbedding = {
    identity(): DesktopBrainSemanticBackend | null | Promise<DesktopBrainSemanticBackend | null>
    embed(texts: readonly string[], signal: AbortSignal, revision?: string): Promise<number[][]>
}
export type DesktopBrainSemanticPages = {
    list(): Promise<DesktopBrainSemanticPage[]>
    read(slug: string): Promise<DesktopBrainSemanticPage | null>
    search(query: string, limit: number): Promise<DesktopBrainSemanticKeywordResult>
}
export type DesktopBrainSemanticIndexStore = {
    list(): Promise<DesktopBrainSemanticIndexEntry[]>
    write(entry: DesktopBrainSemanticIndexEntry): Promise<void>
    remove(chunkIds: readonly string[]): Promise<void>
    removePage(slug: string): Promise<void>
    pending(): Promise<DesktopBrainSemanticPending[]>
    queue(pending: DesktopBrainSemanticPending): Promise<void>
    removePending(chunkIds: readonly string[]): Promise<void>
}
export type DesktopBrainSemanticAuthority = (signal: AbortSignal) => Promise<void>
export type DesktopBrainSemanticPorts = {
    pages: DesktopBrainSemanticPages
    embedding: DesktopBrainSemanticEmbedding
    store: DesktopBrainSemanticIndexStore
    authority: DesktopBrainSemanticAuthority
}
