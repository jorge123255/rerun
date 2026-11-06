import { z } from 'zod'
import { foremanBindingSchema } from './desktop-foreman.js'

export const DESKTOP_FOREMAN_DOCS_CONTRACT_VERSION = 1 as const
export const DESKTOP_FOREMAN_DOCS_LIMITS = {
    corpusTtlMs: 60 * 60 * 1000,
    fetchTimeoutMs: 10_000,
    bridgeTimeoutMs: 15_000,
    passageLimit: 4,
    passagesPerPage: 2,
    passageChars: 1600,
    maxQueryChars: 500,
    maxCorpusBytes: 1_000_000,
    maxPages: 100,
    maxToolCallIdChars: 256,
    maxRequestBytes: 16 * 1024,
    maxResponseBytes: 128 * 1024,
    maxRedirects: 3,
} as const

export const desktopForemanDocsCorpusSchema = z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    documentation: z.url().max(2048).refine(isDesktopForemanDocsCitation, 'Documentation must stay on docs.rerun.build'),
    exportUrl: z.url().max(2048).refine(isDesktopForemanDocsCitation, 'Documentation must stay on docs.rerun.build'),
    format: z.literal('mintlify-llms-full-v1'),
})
export type DesktopForemanDocsCorpus = z.infer<typeof desktopForemanDocsCorpusSchema>
export const RERUN_PUBLIC_DOCS_CORPUS = {
    id: 'rerun-public-docs',
    documentation: 'https://docs.rerun.build',
    exportUrl: 'https://docs.rerun.build/llms-full.txt',
    format: 'mintlify-llms-full-v1',
} as const satisfies DesktopForemanDocsCorpus

export function isDesktopForemanDocsCitation(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && url.hostname === 'docs.rerun.build' && !url.port && !url.username && !url.password
    } catch {
        return false
    }
}

const citationSchema = z.url().max(2048).refine(isDesktopForemanDocsCitation, 'Citation must stay on docs.rerun.build')
export const desktopForemanDocsPassageSchema = z.strictObject({
    title: z.string().trim().min(1).max(600),
    url: citationSchema,
    text: z.string().min(1).max(DESKTOP_FOREMAN_DOCS_LIMITS.passageChars),
})
export type DesktopForemanDocsPassage = z.infer<typeof desktopForemanDocsPassageSchema>
export const desktopForemanDocsPageSchema = z.strictObject({ title: z.string().trim().min(1).max(512), url: citationSchema })
export type DesktopForemanDocsPage = z.infer<typeof desktopForemanDocsPageSchema>

export const desktopForemanDocsSourceSchema = z.strictObject({
    corpusId: z.string().max(128),
    sourceUrl: citationSchema,
    cacheState: z.enum(['fresh', 'revalidated', 'stale']),
    fetchedAt: z.string().max(64),
    ageMs: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive().max(DESKTOP_FOREMAN_DOCS_LIMITS.maxCorpusBytes),
    version: z.string().min(1).max(512),
})
export type DesktopForemanDocsSource = z.infer<typeof desktopForemanDocsSourceSchema>

export const desktopForemanDocsResultSchema = z.strictObject({
    status: z.enum(['ok', 'empty', 'unavailable', 'cancelled']),
    documentation: citationSchema,
    passages: z.array(desktopForemanDocsPassageSchema).max(DESKTOP_FOREMAN_DOCS_LIMITS.passageLimit),
    pages: z.array(desktopForemanDocsPageSchema).max(DESKTOP_FOREMAN_DOCS_LIMITS.maxPages).optional(),
    note: z.string().max(2400).optional(),
    source: desktopForemanDocsSourceSchema.nullable(),
})
export type DesktopForemanDocsResult = z.infer<typeof desktopForemanDocsResultSchema>

export const desktopForemanDocsQuerySchema = z.strictObject({
    query: z.string().trim().min(1).max(DESKTOP_FOREMAN_DOCS_LIMITS.maxQueryChars),
})
export const desktopForemanDocsRequestSchema = desktopForemanDocsQuerySchema.extend({
    binding: foremanBindingSchema,
    toolCallId: z.string().min(1).max(DESKTOP_FOREMAN_DOCS_LIMITS.maxToolCallIdChars).refine(value => !/[\p{Cc}]/u.test(value), 'Invalid tool call identity'),
    corpus: desktopForemanDocsCorpusSchema,
}).strict()
export type DesktopForemanDocsRequest = z.infer<typeof desktopForemanDocsRequestSchema>
export const desktopForemanDocsInternalRequestSchema = desktopForemanDocsRequestSchema.extend({
    action: z.literal('search_docs'),
    launchNonce: z.uuid(),
}).strict()

export const desktopForemanDocsReceiptSchema = z.strictObject({
    request: desktopForemanDocsRequestSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['pending', 'completed']),
    result: desktopForemanDocsResultSchema.nullable(),
    createdAt: z.string().max(64),
    updatedAt: z.string().max(64),
})
export type DesktopForemanDocsReceipt = z.infer<typeof desktopForemanDocsReceiptSchema>

export const FOREMAN_SEARCH_DOCS_DESCRIPTION = 'Search the Rerun documentation (https://docs.rerun.build) and get back the passages that answer the question, each with the link it comes from. Use it for any question about how Rerun itself works, its limits, its pricing or its API, rather than answering from memory, and whenever you or the user are stuck: a tool that fails in a way you did not expect, a step in the app they cannot find or cannot get through. Hand the user the link of the passage you used. Query in English, in keywords rather than a sentence, however the user wrote to you.'
