import { z } from 'zod'
import { desktopPortablePackageManifestSchema } from './desktop-portable-templates.js'
import { desktopTemplateRevisionSchema } from './desktop-templates.js'
import { desktopCoworkerShareDatabasePreviewSchema } from './desktop-coworker-share-database.js'
import { desktopCoworkerShareMemoryPreviewSchema } from './desktop-coworker-share-memory.js'

export const desktopCoworkerShareIncludeSchema = z.strictObject({
    memories: z.boolean(),
    database: z.boolean(),
    files: z.boolean(),
})
export type DesktopCoworkerShareInclude = z.infer<typeof desktopCoworkerShareIncludeSchema>

export const DESKTOP_COWORKER_SHARE_FILES_NOT_SELECTED = 'Workspace files were left out of this export.'

export const desktopCoworkerShareSourceSchema = z.strictObject({
    workspaceId: z.number().int().positive(),
    agentId: z.string().min(1).max(160),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
    revision: desktopTemplateRevisionSchema,
    setup: z.strictObject({ required: z.boolean().nullable(), prompt: z.string().max(25 * 1024 * 1024), answered: z.boolean() }),
    config: z.record(z.string(), z.unknown()),
    envKeys: z.array(z.string().min(1).max(200)).max(100),
    mcpAuth: z.array(z.strictObject({ server: z.string().min(1).max(200), kind: z.enum(['oauth', 'managed', 'device', 'unknown']) })).max(50),
    members: z.array(z.strictObject({
        path: z.string().min(1).max(512),
        bytes: z.instanceof(Uint8Array),
        kind: z.enum(['instruction', 'config', 'text', 'skill', 'binary']),
        binary: z.boolean(),
        textScanned: z.boolean(),
        flagged: z.array(z.string().min(1).max(80)).max(20),
        ownership: z.enum(['user', 'system', 'connector', 'unknown']),
    })).max(4_000),
})
export type DesktopCoworkerShareSource = z.infer<typeof desktopCoworkerShareSourceSchema>

export const desktopCoworkerSnapshotManifestSchema = desktopPortablePackageManifestSchema
export type DesktopCoworkerSnapshotManifest = z.infer<typeof desktopCoworkerSnapshotManifestSchema>

export const desktopCoworkerSnapshotResultSchema = z.strictObject({
    manifest: desktopCoworkerSnapshotManifestSchema,
    archiveSha256: desktopTemplateRevisionSchema,
    archiveBytes: z.number().int().positive().max(160 * 1024 * 1024),
    reused: z.boolean(),
})
export type DesktopCoworkerSnapshotResult = z.infer<typeof desktopCoworkerSnapshotResultSchema>

export const desktopCoworkerShareReviewResultSchema = desktopCoworkerSnapshotResultSchema.extend({
    reviewId: z.string().regex(/^[a-f0-9]{64}$/),
})
export type DesktopCoworkerShareReviewResult = z.infer<typeof desktopCoworkerShareReviewResultSchema>

export const desktopCoworkerSharePlanSchema = z.strictObject({
    agentName: z.string().min(1).max(200),
    sourceRevision: desktopTemplateRevisionSchema.optional(),
    /** Present only when the canonical capture/validation/fresh-install binding is mounted. */
    memoryPreview: desktopCoworkerShareMemoryPreviewSchema.optional(),
    databasePreview: desktopCoworkerShareDatabasePreviewSchema.optional(),
    unavailable: z.strictObject({ memories: z.string().min(1).max(400).optional(), database: z.string().min(1).max(400).optional(), files: z.string().min(1).max(400).optional() }).optional(),
    warnings: z.array(z.string().min(1).max(400)).max(30),
    envKeyCount: z.number().int().nonnegative().max(100),
    mcpAuthCount: z.number().int().nonnegative().max(50),
    contents: z.strictObject({
        memories: z.strictObject({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
        database: z.strictObject({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
        files: z.strictObject({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
    }),
})
export type DesktopCoworkerSharePlan = z.infer<typeof desktopCoworkerSharePlanSchema>

export const desktopCoworkerShareReviewInputSchema = z.strictObject({
    workspaceId: z.number().int().positive(),
    agentId: z.string().min(1).max(160),
    sourceRevision: desktopTemplateRevisionSchema,
    requestId: z.string().min(1).max(160),
    include: desktopCoworkerShareIncludeSchema,
})
export type DesktopCoworkerShareReviewInput = z.infer<typeof desktopCoworkerShareReviewInputSchema>

export const desktopCoworkerShareExportInputSchema = desktopCoworkerShareReviewInputSchema.extend({
    reviewId: z.string().regex(/^[a-f0-9]{64}$/),
    expectedDigest: desktopTemplateRevisionSchema,
})
export type DesktopCoworkerShareExportInput = z.infer<typeof desktopCoworkerShareExportInputSchema>

export const desktopCoworkerShareImportInputSchema = z.strictObject({
    requestId: z.string().min(1).max(160),
    snapshotId: z.string().regex(/^[a-f0-9]{32}$/),
    expectedDigest: desktopTemplateRevisionSchema,
    targetWorkspaceId: z.number().int().positive(),
})
export type DesktopCoworkerShareImportInput = z.infer<typeof desktopCoworkerShareImportInputSchema>

export const desktopCoworkerShareRevokeInputSchema = z.strictObject({
    requestId: z.string().min(1).max(160),
    snapshotId: z.string().regex(/^[a-f0-9]{32}$/),
    expectedRevision: desktopTemplateRevisionSchema,
})
export type DesktopCoworkerShareRevokeInput = z.infer<typeof desktopCoworkerShareRevokeInputSchema>

export const desktopCoworkerShareReceiptSchema = z.strictObject({
    requestId: z.string().min(1).max(160),
    operation: z.enum(['export', 'import', 'revoke']),
    status: z.enum(['created', 'imported', 'revoked', 'uncertain']),
    snapshotId: z.string().regex(/^[a-f0-9]{32}$/),
    recoverable: z.boolean(),
    reason: z.string().max(400).optional(),
    createdAt: z.string().max(64),
})
export type DesktopCoworkerShareReceipt = z.infer<typeof desktopCoworkerShareReceiptSchema>

export const desktopCoworkerImportPlanSchema = z.strictObject({
    capabilities: z.strictObject({
        enabled: z.literal(false),
        history: z.literal('empty'),
        connectionId: z.null(),
        provider: z.null(),
        model: z.null(),
        grants: z.literal('off'),
    }),
})
export type DesktopCoworkerImportPlan = z.infer<typeof desktopCoworkerImportPlanSchema>
