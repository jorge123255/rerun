import { z } from 'zod'

/** Portable coworker-memory transfer. Coordinates field names with RD38 B (database) and E (share UI). */
export const DESKTOP_COWORKER_SHARE_MEMORY_FORMAT = 'desktop-coworker-share-memory' as const
export const DESKTOP_COWORKER_SHARE_MEMORY_FORMAT_VERSION = 1 as const

export const DESKTOP_COWORKER_SHARE_MEMORY_LIMITS = {
    maxNotes: 2_000,
    maxNoteContentChars: 8_192,
    maxNoteBytes: 24_576,
    maxTotalBytes: 16 * 1024 * 1024,
    maxIdLength: 128,
    maxKindLength: 64,
    maxTags: 32,
    maxTagLength: 64,
    maxRequestIdLength: 160,
} as const

export const desktopCoworkerShareMemoryNoteIdSchema = z
    .string()
    .min(1)
    .max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxIdLength)
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine(id => id !== 'recall', { message: 'Reserved memory id' })

export const desktopCoworkerShareMemoryNoteSchema = z.strictObject({
    id: desktopCoworkerShareMemoryNoteIdSchema,
    kind: z.string().trim().min(1).max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxKindLength),
    tags: z.array(z.string().trim().min(1).max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxTagLength)).max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxTags),
    createdAt: z.string().min(1).max(64),
    content: z.string().trim().min(1).max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxNoteContentChars),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
})
export type DesktopCoworkerShareMemoryNote = z.infer<typeof desktopCoworkerShareMemoryNoteSchema>

export const desktopCoworkerShareMemoryBucketSchema = z.strictObject({
    count: z.number().int().nonnegative().max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxNotes),
    bytes: z.number().int().nonnegative().max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxTotalBytes),
})
export type DesktopCoworkerShareMemoryBucket = z.infer<typeof desktopCoworkerShareMemoryBucketSchema>

export const desktopCoworkerShareMemoryPackageSchema = z.strictObject({
    format: z.literal(DESKTOP_COWORKER_SHARE_MEMORY_FORMAT),
    formatVersion: z.literal(DESKTOP_COWORKER_SHARE_MEMORY_FORMAT_VERSION),
    sourceWorkspaceId: z.number().int().positive(),
    sourceAgentId: z.string().min(1).max(160),
    captureRequestId: z.string().min(1).max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxRequestIdLength),
    capturedAt: z.string().min(1).max(64),
    notes: z.array(desktopCoworkerShareMemoryNoteSchema).max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxNotes),
    contents: desktopCoworkerShareMemoryBucketSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
})
export type DesktopCoworkerShareMemoryPackage = z.infer<typeof desktopCoworkerShareMemoryPackageSchema>

/** Shared transfer envelope field names for A/B/E. Root owns aggregate wiring. */
export const desktopCoworkerShareTransferSectionSchema = z.enum(['memories', 'database', 'files'])
export type DesktopCoworkerShareTransferSection = z.infer<typeof desktopCoworkerShareTransferSectionSchema>

export const desktopCoworkerShareMemoryPreviewSchema = z.strictObject({
    available: z.boolean(),
    reason: z.string().max(400).optional(),
    contents: desktopCoworkerShareMemoryBucketSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
})
export type DesktopCoworkerShareMemoryPreview = z.infer<typeof desktopCoworkerShareMemoryPreviewSchema>

export const desktopCoworkerShareMemoryRestoreResultSchema = z.strictObject({
    status: z.enum(['installed', 'reused', 'unavailable']),
    captureRequestId: z.string().min(1).max(DESKTOP_COWORKER_SHARE_MEMORY_LIMITS.maxRequestIdLength),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    destinationAgentId: z.string().min(1).max(160),
    installedCount: z.number().int().nonnegative(),
    reusedCount: z.number().int().nonnegative(),
    reason: z.string().max(400).optional(),
})
export type DesktopCoworkerShareMemoryRestoreResult = z.infer<typeof desktopCoworkerShareMemoryRestoreResultSchema>
