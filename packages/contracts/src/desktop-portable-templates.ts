import { z } from 'zod'
import {
    DESKTOP_TEMPLATE_PROSE_WARNING,
    DESKTOP_TEMPLATE_PORTABLE_MAX_FILES,
    desktopTemplateAgentKeySchema,
    desktopTemplateExclusionSchema,
    desktopTemplateIdSchema,
    desktopTemplatePositionSchema,
    desktopTemplateRedactionSchema,
    desktopTemplateRelativePathSchema,
    desktopTemplateRequestIdSchema,
    desktopTemplateRevisionSchema,
    desktopTemplateSkillSlugSchema,
    isDesktopTemplateRelativePath,
} from './desktop-templates.js'

// Local portable packages. Public identity stays the opaque desktop template id;
// archives only carry package-local coworker keys. This contract imports the
// accepted desktop-template identity/install types rather than inventing a second
// template system.

export const DESKTOP_PORTABLE_TEMPLATE_FORMAT = 'desktop-portable-template' as const
export const DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION = 1 as const

export const DESKTOP_PORTABLE_TEMPLATE_LIMITS = {
    maxCoworkers: 12,
    maxFiles: DESKTOP_TEMPLATE_PORTABLE_MAX_FILES,
    maxFileBytes: 25 * 1024 * 1024,
    maxTotalBytes: 150 * 1024 * 1024,
    maxCompressedBytes: 160 * 1024 * 1024,
    maxMembers: 4_000,
    maxTitleLength: 80,
    maxElapsedMs: 120_000,
    maxWalkEntries: 4_000,
} as const

export const DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING =
    'Selected instructions, files, skills and binary assets are copied as written. Binary files are not text-scanned for secrets.' as const

export const desktopPortableTemplateLimitsSchema = z.strictObject({
    maxCoworkers: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCoworkers),
    maxFiles: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles),
    maxFileBytes: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes),
    maxTotalBytes: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTotalBytes),
    maxCompressedBytes: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes),
    maxMembers: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxMembers),
    maxTitleLength: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTitleLength),
    maxElapsedMs: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxElapsedMs),
    maxWalkEntries: z.literal(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxWalkEntries),
})
export type DesktopPortableTemplateLimits = z.infer<typeof desktopPortableTemplateLimitsSchema>

export const desktopPortablePackageDigestSchema = desktopTemplateRevisionSchema
export const desktopPortableArtifactIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const desktopPortableUploadIdSchema = z.uuid()

export const desktopSkillOwnershipKindSchema = z.enum(['user', 'system', 'connector', 'unknown'])
export type DesktopSkillOwnershipKind = z.infer<typeof desktopSkillOwnershipKindSchema>

export const desktopPortableRequirementKindSchema = z.enum([
    'environment-key',
    'credential-name',
    'mcp-reconnect',
    'service-reconnect',
    'model-rebind',
    'connection-rebind',
    'schedule-inactive',
    'trigger-inactive',
])

export const desktopPortableRequirementSchema = z.strictObject({
    kind: desktopPortableRequirementKindSchema,
    name: z.string().min(1).max(200),
    detail: z.string().max(400).optional(),
})
export type DesktopPortableRequirement = z.infer<typeof desktopPortableRequirementSchema>

export const desktopPortableMemberKindSchema = z.enum(['instruction', 'config', 'text', 'skill', 'binary'])
export type DesktopPortableMemberKind = z.infer<typeof desktopPortableMemberKindSchema>

export const desktopPortableMemberSchema = z.strictObject({
    path: desktopTemplateRelativePathSchema,
    bytes: z.number().int().nonnegative().max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes),
    kind: desktopPortableMemberKindSchema,
    contentDigest: desktopPortablePackageDigestSchema,
    flagged: z.array(z.string().min(1).max(80)).max(20),
    binary: z.boolean(),
    textScanned: z.boolean(),
})
export type DesktopPortableMember = z.infer<typeof desktopPortableMemberSchema>

export const desktopPortableCoworkerSchema = z.strictObject({
    agentKey: desktopTemplateAgentKeySchema,
    name: z.string().min(1).max(60),
    description: z.string().max(2_000),
    setup: z.strictObject({
        required: z.boolean().nullable(),
        prompt: z.string().max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes),
        answered: z.boolean(),
    }),
    members: z.array(desktopPortableMemberSchema).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles),
    exclusions: z.array(desktopTemplateExclusionSchema).max(500),
    redactions: z.array(desktopTemplateRedactionSchema).max(50),
    strippedConfigKeys: z.array(z.string().min(1).max(200)).max(100),
    requirements: z.array(desktopPortableRequirementSchema).max(200),
    envKeys: z.array(z.string().min(1).max(200)).max(100),
    mcpAuth: z.array(z.strictObject({
        server: z.string().min(1).max(200),
        kind: z.enum(['oauth', 'managed', 'device', 'unknown']),
    })).max(50),
})
export type DesktopPortableCoworker = z.infer<typeof desktopPortableCoworkerSchema>

export const desktopPortablePackageManifestSchema = z.strictObject({
    format: z.literal(DESKTOP_PORTABLE_TEMPLATE_FORMAT),
    formatVersion: z.literal(DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION),
    // Package-local identity only. Never an engine id, install/session/run id, or host path.
    packageKey: z.string().regex(/^[a-f0-9]{32}$/),
    title: z.string().min(1).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTitleLength),
    capturedAt: z.string().min(20).max(40),
    proseWarning: z.union([
        z.literal(DESKTOP_TEMPLATE_PROSE_WARNING),
        z.literal(DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING),
    ]),
    limits: desktopPortableTemplateLimitsSchema,
    contentDigest: desktopPortablePackageDigestSchema,
    coworkers: z.array(desktopPortableCoworkerSchema).min(1).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCoworkers),
    fidelity: z.strictObject({
        binaryAssets: z.boolean(),
        userSkillTrees: z.boolean(),
        sourceKind: z.enum(['portable-capture', 'local-v1-export']),
        notes: z.array(z.string().min(1).max(400)).max(20),
    }),
    excludedCategories: z.array(z.enum([
        'credentials',
        'history',
        'memory',
        'database',
        'connector-skill',
        'system-skill',
        'service-registry',
        'native-grant',
        'tool-permissions',
        'active-schedule',
        'active-trigger',
        'browser-profile',
        'private-memory',
        'paid-data',
        'cached-pages',
        'chat-transcript',
        'tool-arguments',
        'telemetry',
        'marketplace',
        'hosted-publish',
    ])).max(40),
})
export type DesktopPortablePackageManifest = z.infer<typeof desktopPortablePackageManifestSchema>

export const desktopPortableProvenanceSchema = z.strictObject({
    importedAt: z.string().min(20).max(40),
    sourcePackageKey: z.string().regex(/^[a-f0-9]{32}$/),
    sourceContentDigest: desktopPortablePackageDigestSchema,
    sourceTitle: z.string().min(1).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTitleLength),
    uploadId: desktopPortableUploadIdSchema.optional(),
})
export type DesktopPortableProvenance = z.infer<typeof desktopPortableProvenanceSchema>

export const desktopPortableExportResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('exported'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
        artifactId: desktopPortableArtifactIdSchema,
        contentDigest: desktopPortablePackageDigestSchema,
        bytes: z.number().int().positive().max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes),
        fileName: z.string().min(1).max(180),
        fidelity: desktopPortablePackageManifestSchema.shape.fidelity,
    }),
    z.strictObject({
        status: z.literal('uncertain'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        recoverable: z.literal(true),
        reason: z.string().min(1).max(400),
    }),
])
export type DesktopPortableExportResult = z.infer<typeof desktopPortableExportResultSchema>

export const desktopPortableImportResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('imported'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
        provenance: desktopPortableProvenanceSchema,
        fidelity: desktopPortablePackageManifestSchema.shape.fidelity,
    }),
    z.strictObject({
        status: z.literal('uncertain'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        recoverable: z.literal(true),
        reason: z.string().min(1).max(400),
    }),
])
export type DesktopPortableImportResult = z.infer<typeof desktopPortableImportResultSchema>

export const desktopPortableDeleteResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('deleted'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
        tombstoneId: z.uuid(),
    }),
    z.strictObject({
        status: z.literal('uncertain'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        recoverable: z.literal(true),
        reason: z.string().min(1).max(400),
    }),
])
export type DesktopPortableDeleteResult = z.infer<typeof desktopPortableDeleteResultSchema>

export const desktopPortableOperationSchema = z.discriminatedUnion('operation', [
    z.strictObject({
        operation: z.literal('export'),
        requestId: desktopTemplateRequestIdSchema,
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
    }),
    z.strictObject({
        operation: z.literal('import-package'),
        requestId: desktopTemplateRequestIdSchema,
        uploadId: desktopPortableUploadIdSchema,
        title: z.string().trim().min(1).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTitleLength).optional(),
    }),
    z.strictObject({
        operation: z.literal('delete'),
        requestId: desktopTemplateRequestIdSchema,
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
    }),
    z.strictObject({
        operation: z.literal('portable-receipt'),
        requestId: desktopTemplateRequestIdSchema,
    }),
])
export type DesktopPortableOperation = z.infer<typeof desktopPortableOperationSchema>

export const desktopPortableReceiptSchema = z.strictObject({
    requestId: desktopTemplateRequestIdSchema,
    receiptId: z.uuid(),
    operation: z.enum(['export', 'import-package', 'delete']),
    status: z.string().min(1).max(40),
    templateId: desktopTemplateIdSchema.nullable(),
    revision: desktopTemplateRevisionSchema.nullable(),
    artifactId: desktopPortableArtifactIdSchema.nullable(),
    recoverable: z.boolean(),
})
export type DesktopPortableReceipt = z.infer<typeof desktopPortableReceiptSchema>

export function isDesktopPortableRelativePath(path: string): boolean {
    return isDesktopTemplateRelativePath(path)
}

export const desktopPortableSkillSlugSchema = desktopTemplateSkillSlugSchema
export const desktopPortablePositionSchema = desktopTemplatePositionSchema

export const DESKTOP_PORTABLE_MANIFEST_MEMBER = 'manifest.json'
export const DESKTOP_PORTABLE_COWORKER_PREFIX = 'coworkers/'
