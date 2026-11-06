import { z } from 'zod'
import { memoryRecallQuerySchema, memorySchema } from './memory.js'

// Bounds for one coworker’s derived semantic index. Notes stay in the existing memory store.
// These caps reject oversized input. They do not select or call an embedding provider.
export const DESKTOP_SEMANTIC_QUERY_MAX = 512
export const DESKTOP_SEMANTIC_LIMIT_MAX = 20
export const DESKTOP_SEMANTIC_NOTE_MAX = 8192
export const DESKTOP_SEMANTIC_BATCH_MAX = 16
export const DESKTOP_SEMANTIC_NOTES_MAX = 512
export const DESKTOP_SEMANTIC_DIMENSIONS_MAX = 4096
export const DESKTOP_SEMANTIC_PENDING_MAX = 64
export const DESKTOP_SEMANTIC_RETRIES_MAX = 3
export const DESKTOP_SEMANTIC_DEADLINE_MS = 5000
export const DESKTOP_SEMANTIC_STORE_BYTES_MAX = 8_388_608
export const DESKTOP_SEMANTIC_DETAIL_MAX = 300

// Same floor as AUTO_RECALL_MIN_SIMILARITY in apps/engine/src/memory/store.ts.
// Recall passes that engine constant into rankRecallHits. This copy is the public contract.
export const DESKTOP_SEMANTIC_SIMILARITY_FLOOR = 0.25

export const desktopSemanticRecallModes = ['semantic', 'partial', 'keyword-only', 'unavailable'] as const
export type DesktopSemanticRecallMode = (typeof desktopSemanticRecallModes)[number]

export const desktopSemanticIndexModes = ['ready', 'partial', 'rebuilding', 'keyword-only', 'invalid', 'unavailable'] as const
export type DesktopSemanticIndexMode = (typeof desktopSemanticIndexModes)[number]

export const desktopSemanticReinforceModes = ['full', 'touch', 'none'] as const
export type DesktopSemanticReinforceMode = (typeof desktopSemanticReinforceModes)[number]

export const desktopSemanticEmbedFailures = ['unconfigured', 'unavailable', 'refused', 'timeout', 'cancelled', 'invalid'] as const
export type DesktopSemanticEmbedFailure = (typeof desktopSemanticEmbedFailures)[number]

export const DESKTOP_SEMANTIC_DETAIL = {
    unconfigured: 'Keyword search only. An embedding backend is not configured.',
    unavailable: 'Keyword search only. The embedding backend is unavailable.',
    refused: 'Keyword search only. The embedding backend refused the request.',
    timeout: 'Keyword search only. The embedding backend timed out.',
    cancelled: 'Keyword search only. Semantic recall was cancelled.',
    invalid: 'Keyword search only. The semantic index is invalid and was not used.',
    empty: 'Keyword search only. The semantic index is empty.',
    changed: 'Keyword search only. The embedding backend changed, so the previous index was not used.',
    pending: 'Keyword search only. Semantic indexing has not finished.',
    partial: 'Some notes are still indexing. Keyword matches are included.',
    semantic: 'Semantic and keyword matches.',
    owner: 'This coworker’s memories are not available.',
    storage: 'Some notes were not indexed because the semantic index reached its storage limit.',
} as const

const localId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

export const desktopSemanticBackendIdentitySchema = z.strictObject({
    backendId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    model: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64),
    dimensions: z.number().int().min(1).max(DESKTOP_SEMANTIC_DIMENSIONS_MAX),
})
export type DesktopSemanticBackendIdentity = z.infer<typeof desktopSemanticBackendIdentitySchema>

// Canonical JSON for the backend fingerprint. Field order is fixed. No credentials.
export function desktopSemanticBackendCanonical(identity: DesktopSemanticBackendIdentity): string {
    return JSON.stringify({
        backendId: identity.backendId,
        dimensions: identity.dimensions,
        model: identity.model,
        version: identity.version,
    })
}

export const desktopSemanticRecallRequestSchema = z.strictObject({
    query: memoryRecallQuerySchema.shape.query.max(DESKTOP_SEMANTIC_QUERY_MAX),
    limit: memoryRecallQuerySchema.shape.limit.unwrap().max(DESKTOP_SEMANTIC_LIMIT_MAX).default(5),
    includeDormant: memoryRecallQuerySchema.shape.includeDormant,
    reinforce: z.enum(desktopSemanticReinforceModes).default('none'),
})
export type DesktopSemanticRecallRequest = z.infer<typeof desktopSemanticRecallRequestSchema>

// Panel and the coworker memories route always search this way. Chat and curation pass their own mode.
export function desktopSemanticPanelRecall(request: DesktopSemanticRecallRequest): DesktopSemanticRecallRequest {
    return { ...request, reinforce: 'none' }
}

export const desktopSemanticRecallNoteSchema = z.strictObject({
    id: memorySchema.shape.id.pipe(localId),
    content: memorySchema.shape.content.max(DESKTOP_SEMANTIC_NOTE_MAX),
    kind: memorySchema.shape.kind,
    tags: memorySchema.shape.tags,
    createdAt: memorySchema.shape.createdAt,
    strength: z.number().finite().min(0).max(1),
    status: memorySchema.shape.status.unwrap(),
})
export type DesktopSemanticRecallNote = z.infer<typeof desktopSemanticRecallNoteSchema>

export const desktopSemanticIndexStatusSchema = z.strictObject({
    mode: z.enum(desktopSemanticIndexModes),
    backend: desktopSemanticBackendIdentitySchema.nullable(),
    indexed: z.number().int().nonnegative().max(DESKTOP_SEMANTIC_NOTES_MAX),
    pending: z.number().int().nonnegative().max(DESKTOP_SEMANTIC_PENDING_MAX),
    omitted: z.number().int().nonnegative(),
    detail: z.string().max(DESKTOP_SEMANTIC_DETAIL_MAX),
})
export type DesktopSemanticIndexStatus = z.infer<typeof desktopSemanticIndexStatusSchema>

export const desktopSemanticRecallResultSchema = z.strictObject({
    mode: z.enum(desktopSemanticRecallModes),
    detail: z.string().max(DESKTOP_SEMANTIC_DETAIL_MAX),
    memories: z.array(desktopSemanticRecallNoteSchema).max(DESKTOP_SEMANTIC_LIMIT_MAX),
    index: desktopSemanticIndexStatusSchema,
})
export type DesktopSemanticRecallResult = z.infer<typeof desktopSemanticRecallResultSchema>

export const desktopSemanticMaintainSchema = z.strictObject({
    operation: z.enum(['retry', 'reconcile']),
})
export type DesktopSemanticMaintainRequest = z.infer<typeof desktopSemanticMaintainSchema>

// Current note bytes used for ranking. Paths, engine ids, and credentials are not part of this snapshot.
export type DesktopSemanticCanonicalNote = {
    id: string
    content: string
    kind: string
    tags: string[]
    createdAt: string
    lastAccessedAt: string | null
    accessCount: number
}

export type DesktopSemanticOwner = { localAgentId: string }

export interface DesktopSemanticOwnerPort {
    requireCurrentOwner(localAgentId: string): Promise<DesktopSemanticOwner | null>
}

export interface DesktopSemanticNotesPort {
    listNotes(localAgentId: string): Promise<DesktopSemanticCanonicalNote[]>
    readNote(localAgentId: string, noteId: string): Promise<DesktopSemanticCanonicalNote | null>
    // Changes when a note is removed or the coworker’s notes are cleared. Root supplies it.
    generation(localAgentId: string): Promise<string>
}

export interface DesktopSemanticEmbeddingPort {
    // Local configuration only. Must not call a network provider.
    identity(): DesktopSemanticBackendIdentity | null
    embed(texts: readonly string[], signal: AbortSignal, deadlineMs: number): Promise<
        | { ok: true; vectors: number[][]; identity: DesktopSemanticBackendIdentity }
        | { ok: false; reason: DesktopSemanticEmbedFailure }
    >
}

export type DesktopSemanticIndexRecord = {
    noteId: string
    contentFingerprint: string
    backendFingerprint: string
    dimensions: number
    vector: number[]
}

export type DesktopSemanticPendingWork = {
    noteId: string
    contentFingerprint: string
    generation: string
    revoke: number
    attempts: number
    backendFingerprint: string
}

export type DesktopSemanticOwnerIndex = {
    generation: string
    revoke: number
    invalid: boolean
    records: DesktopSemanticIndexRecord[]
    pending: DesktopSemanticPendingWork[]
}

export interface DesktopSemanticIndexStore {
    read(ownerId: string): Promise<DesktopSemanticOwnerIndex | null>
    write(ownerId: string, next: DesktopSemanticOwnerIndex): Promise<void>
    listOwnerIds(): Promise<string[]>
}

export type DesktopSemanticMutationResult = {
    accepted: boolean
    reason: 'current' | 'queued' | 'unconfigured' | 'missing' | 'owner' | 'bounds' | 'pending-full' | 'cancelled' | 'invalid' | 'deleted' | 'cleared'
}
