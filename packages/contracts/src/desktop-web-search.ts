import { z } from 'zod'

export const DESKTOP_WEB_SEARCH_DEFAULT_RESULTS = 5
export const DESKTOP_WEB_SEARCH_MAX_RESULTS = 20
export const DESKTOP_WEB_SEARCH_DEADLINE_MS = 15_000
export const DESKTOP_WEB_SEARCH_QUERY_MAX_CHARS = 512
export const DESKTOP_WEB_SEARCH_TITLE_MAX_CHARS = 512
export const DESKTOP_WEB_SEARCH_SNIPPET_MAX_CHARS = 4_000
export const DESKTOP_WEB_SEARCH_URL_MAX_CHARS = 8_192
export const DESKTOP_WEB_SEARCH_AGGREGATE_MAX_BYTES = 65_536

const publicId = z.string().trim().min(1).max(256)
const utf8 = new TextEncoder()

export const desktopWebSearchRunIdentitySchema = z.strictObject({
    agentId: publicId,
    sessionId: publicId,
    runId: publicId,
    toolCallId: publicId,
})
export type DesktopWebSearchRunIdentity = z.infer<typeof desktopWebSearchRunIdentitySchema>
export type DesktopWebSearchInvocationIdentity = DesktopWebSearchRunIdentity & { adapterGeneration: string }

export const desktopWebSearchInputSchema = z.strictObject({
    query: z.string().trim().min(1).max(DESKTOP_WEB_SEARCH_QUERY_MAX_CHARS),
    maxResults: z.number().int().positive().max(DESKTOP_WEB_SEARCH_MAX_RESULTS).default(DESKTOP_WEB_SEARCH_DEFAULT_RESULTS),
})
export type DesktopWebSearchInput = z.infer<typeof desktopWebSearchInputSchema>

export function desktopWebSearchInputOf(input: unknown): DesktopWebSearchInput {
    const parsed = desktopWebSearchInputSchema.parse(input)
    return { ...parsed, query: parsed.query.replace(/\s+/g, ' ') }
}

export const desktopWebSearchResultSchema = z.strictObject({
    title: z.string().trim().min(1).max(DESKTOP_WEB_SEARCH_TITLE_MAX_CHARS),
    url: z.string().min(1).max(DESKTOP_WEB_SEARCH_URL_MAX_CHARS),
    snippet: z.string().max(DESKTOP_WEB_SEARCH_SNIPPET_MAX_CHARS),
})
export type DesktopWebSearchResult = z.infer<typeof desktopWebSearchResultSchema>

export const desktopWebSearchProvenanceSchema = z.strictObject({ provider: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) })
export type DesktopWebSearchProvenance = z.infer<typeof desktopWebSearchProvenanceSchema>

const desktopWebSearchResponseShape = z.strictObject({
    provenance: desktopWebSearchProvenanceSchema,
    results: z.array(desktopWebSearchResultSchema).max(DESKTOP_WEB_SEARCH_MAX_RESULTS),
})
export const desktopWebSearchResponseSchema = desktopWebSearchResponseShape.superRefine((response, context) => {
    const bytes = utf8.encode(JSON.stringify(response)).byteLength
    if (bytes > DESKTOP_WEB_SEARCH_AGGREGATE_MAX_BYTES) context.addIssue({ code: 'custom', message: `Search response exceeds ${DESKTOP_WEB_SEARCH_AGGREGATE_MAX_BYTES} bytes` })
})
export type DesktopWebSearchResponse = z.infer<typeof desktopWebSearchResponseSchema>

export const desktopWebSearchSuccessSchema = desktopWebSearchResponseShape.extend({ status: z.literal('success') })
export type DesktopWebSearchSuccess = z.infer<typeof desktopWebSearchSuccessSchema>
export const desktopWebSearchFailureSchema = z.strictObject({
    status: z.enum(['unavailable', 'error', 'cancelled', 'uncertain']),
    message: z.string().trim().min(1).max(500),
})
export const desktopWebSearchOutcomeSchema = z.discriminatedUnion('status', [desktopWebSearchSuccessSchema, desktopWebSearchFailureSchema])
export type DesktopWebSearchOutcome = z.infer<typeof desktopWebSearchOutcomeSchema>

export const desktopWebSearchCapabilityViewSchema = z.strictObject({
    status: z.enum(['ready', 'unconfigured', 'unavailable']),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
})
export type DesktopWebSearchCapabilityView = z.infer<typeof desktopWebSearchCapabilityViewSchema>

export type DesktopWebSearchAdapter = {
    generation: string
    search(input: DesktopWebSearchInput & { identity: DesktopWebSearchInvocationIdentity; signal: AbortSignal }): Promise<DesktopWebSearchResponse>
}

export type DesktopWebSearchAuthority = (identity: DesktopWebSearchRunIdentity, signal: AbortSignal) => Promise<{ adapterGeneration: string }>
export type DesktopWebSearchReadinessProjection = (signal: AbortSignal) => Promise<DesktopWebSearchCapabilityView>

export type DesktopWebSearchOutcomeStore = {
    begin(identity: DesktopWebSearchInvocationIdentity, fingerprint: string): Promise<'execute' | DesktopWebSearchOutcome>
    complete(identity: DesktopWebSearchInvocationIdentity, fingerprint: string, outcome: DesktopWebSearchOutcome): Promise<void>
}

export type DesktopWebSearchPorts = {
    adapter?: DesktopWebSearchAdapter | null
    authority: DesktopWebSearchAuthority
    readiness: DesktopWebSearchReadinessProjection
    outcomes: DesktopWebSearchOutcomeStore
}

export async function desktopWebSearchFingerprint(identity: DesktopWebSearchInvocationIdentity, input: DesktopWebSearchInput): Promise<string> {
    const bytes = utf8.encode(JSON.stringify([identity, input]))
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}
