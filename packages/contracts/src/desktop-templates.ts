import { z } from 'zod'

// Private local templates. Browser payloads name local coworker ids only.
// Engine ids and absolute filesystem paths are not part of this contract.

export const DESKTOP_TEMPLATE_PROSE_WARNING =
    'Selected instructions, files, and skills are copied as written. This capture does not prove they contain no secrets.'

export const DESKTOP_TEMPLATE_LIMITS = {
    maxCoworkers: 12,
    maxFiles: 200,
    maxFileBytes: 1_048_576,
    maxTotalBytes: 32 * 1024 * 1024,
    maxTitleLength: 80,
    maxWalkEntries: 2_000,
} as const

export const desktopTemplateLimitsSchema = z.strictObject({
    maxCoworkers: z.literal(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
    maxFiles: z.literal(DESKTOP_TEMPLATE_LIMITS.maxFiles),
    maxFileBytes: z.literal(DESKTOP_TEMPLATE_LIMITS.maxFileBytes),
    maxTotalBytes: z.literal(DESKTOP_TEMPLATE_LIMITS.maxTotalBytes),
    maxTitleLength: z.literal(DESKTOP_TEMPLATE_LIMITS.maxTitleLength),
    maxWalkEntries: z.literal(DESKTOP_TEMPLATE_LIMITS.maxWalkEntries),
})
export type DesktopTemplateLimits = z.infer<typeof desktopTemplateLimitsSchema>

export const desktopTemplateRequestIdSchema = z.uuid()
export const desktopTemplateIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const desktopTemplateRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const desktopTemplateAgentKeySchema = z.string().regex(/^c[0-9]{2}$/)

// Matches apps/ui/lib/desktop/spaces.ts desktopSpaceCoordinateSchema.
const coordinateSchema = z.number().int().min(-1_000_000).max(1_000_000)
export const desktopTemplatePositionSchema = z.strictObject({ col: coordinateSchema, row: coordinateSchema })
export type DesktopTemplatePosition = z.infer<typeof desktopTemplatePositionSchema>

export function isDesktopTemplateRelativePath(path: string): boolean {
    if (path.length < 1 || path.length > 512) return false
    if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
    return path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

export const desktopTemplateRelativePathSchema = z.string().refine(isDesktopTemplateRelativePath, 'Path is not a confined relative path')
export const desktopTemplateSkillSlugSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)

export const desktopTemplateExclusionReasonSchema = z.enum([
    'credentials', 'history', 'memory', 'database', 'connector-skill', 'service-registry',
    'native-grant', 'tool-permissions', 'routine', 'webhook', 'link', 'alias', 'unsupported',
    'over-limit', 'binary', 'collision',
])
export type DesktopTemplateExclusionReason = z.infer<typeof desktopTemplateExclusionReasonSchema>

export const desktopTemplateExclusionSchema = z.strictObject({
    path: z.string().min(1).max(512),
    reason: desktopTemplateExclusionReasonSchema,
})
export type DesktopTemplateExclusion = z.infer<typeof desktopTemplateExclusionSchema>

export const desktopTemplateRedactionSchema = z.strictObject({
    path: desktopTemplateRelativePathSchema,
    reason: z.string().min(1).max(400),
})

const flaggedSchema = z.array(z.string().min(1).max(80)).max(20)
const sourceRevisionSchema = desktopTemplateRevisionSchema

export const desktopTemplateIncludedFileSchema = z.strictObject({
    path: desktopTemplateRelativePathSchema,
    bytes: z.number().int().nonnegative(),
    kind: z.enum(['instruction', 'config']),
    sourceRevision: sourceRevisionSchema,
    flagged: flaggedSchema,
    text: z.string().max(DESKTOP_TEMPLATE_LIMITS.maxFileBytes),
})
export type DesktopTemplateIncludedFile = z.infer<typeof desktopTemplateIncludedFileSchema>

export const desktopTemplateSelectableFileSchema = z.strictObject({
    path: desktopTemplateRelativePathSchema,
    bytes: z.number().int().nonnegative(),
    kind: z.literal('text'),
    sourceRevision: sourceRevisionSchema,
    flagged: flaggedSchema,
})

export const desktopTemplateSkillFileSchema = z.strictObject({
    path: desktopTemplateRelativePathSchema,
    bytes: z.number().int().nonnegative(),
    kind: z.literal('skill'),
    sourceRevision: sourceRevisionSchema,
    flagged: flaggedSchema,
})

export const desktopTemplateSelectableSkillSchema = z.strictObject({
    slug: desktopTemplateSkillSlugSchema,
    name: z.string().max(200),
    description: z.string().max(2_000),
    sourceRevision: sourceRevisionSchema,
    files: z.array(desktopTemplateSkillFileSchema).max(DESKTOP_TEMPLATE_LIMITS.maxFiles),
})

export const desktopTemplateSetupViewSchema = z.strictObject({
    required: z.boolean().nullable(),
    prompt: z.string().max(DESKTOP_TEMPLATE_LIMITS.maxFileBytes),
    answered: z.boolean(),
})

export const desktopTemplateCoworkerPlanSchema = z.strictObject({
    agentId: z.uuid(),
    name: z.string().min(1).max(60),
    description: z.string().max(2_000),
    sourceRevision: sourceRevisionSchema,
    setup: desktopTemplateSetupViewSchema,
    included: z.array(desktopTemplateIncludedFileSchema).max(8),
    selectableFiles: z.array(desktopTemplateSelectableFileSchema).max(DESKTOP_TEMPLATE_LIMITS.maxFiles),
    selectableSkills: z.array(desktopTemplateSelectableSkillSchema).max(100),
    exclusions: z.array(desktopTemplateExclusionSchema).max(500),
    redactions: z.array(desktopTemplateRedactionSchema).max(50),
    strippedConfigKeys: z.array(z.string().min(1).max(200)).max(100),
    blocked: z.string().max(400).nullable(),
})
export type DesktopTemplateCoworkerPlan = z.infer<typeof desktopTemplateCoworkerPlanSchema>

export const desktopTemplatePlanSchema = z.strictObject({
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    planRevision: desktopTemplateRevisionSchema,
    proseWarning: z.literal(DESKTOP_TEMPLATE_PROSE_WARNING),
    limits: desktopTemplateLimitsSchema,
    coworkers: z.array(desktopTemplateCoworkerPlanSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
})
export type DesktopTemplatePlan = z.infer<typeof desktopTemplatePlanSchema>

export const desktopTemplateSelectionSchema = z.strictObject({
    agentId: z.uuid(),
    files: z.array(desktopTemplateRelativePathSchema).max(DESKTOP_TEMPLATE_LIMITS.maxFiles),
    skills: z.array(desktopTemplateSkillSlugSchema).max(100),
    setup: z.strictObject({ required: z.boolean(), prompt: z.string().max(DESKTOP_TEMPLATE_LIMITS.maxFileBytes) }).optional(),
})

export const desktopTemplateCaptureResultSchema = z.strictObject({
    status: z.literal('captured'),
    requestId: desktopTemplateRequestIdSchema,
    receiptId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
})
export type DesktopTemplateCaptureResult = z.infer<typeof desktopTemplateCaptureResultSchema>

export const desktopTemplateCreateDraftResultSchema = z.strictObject({
    requestId: desktopTemplateRequestIdSchema,
    receiptId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
})
export type DesktopTemplateCreateDraftResult = z.infer<typeof desktopTemplateCreateDraftResultSchema>

export const desktopTemplateSourceAgentSchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    description: z.string().max(160),
})
export const desktopTemplateSourcesResultSchema = z.strictObject({
    spaces: z.array(z.strictObject({
        id: z.uuid().nullable(),
        name: z.string().nullable(),
        agents: z.array(desktopTemplateSourceAgentSchema),
    })),
})
export type DesktopTemplateSourcesResult = z.infer<typeof desktopTemplateSourcesResultSchema>

export const desktopTemplateListItemSchema = z.strictObject({
    templateId: desktopTemplateIdSchema,
    title: z.string(),
    revision: desktopTemplateRevisionSchema.nullable(),
    status: z.enum(['draft', 'captured']),
    capturedAt: z.string().nullable(),
    coworkerCount: z.number().int().nonnegative(),
})
export const desktopTemplateListSchema = z.strictObject({
    templates: z.array(desktopTemplateListItemSchema),
})
export type DesktopTemplateList = z.infer<typeof desktopTemplateListSchema>

export const desktopTemplateDetailFileSchema = z.strictObject({
    path: desktopTemplateRelativePathSchema,
    bytes: z.number().int().nonnegative(),
    kind: z.enum(['instruction', 'config', 'text', 'skill']),
    sourceRevision: sourceRevisionSchema,
    flagged: flaggedSchema,
})
export const desktopTemplateDetailCoworkerSchema = z.strictObject({
    agentKey: desktopTemplateAgentKeySchema,
    name: z.string().min(1).max(60),
    description: z.string().max(2_000),
    setup: desktopTemplateSetupViewSchema,
    files: z.array(desktopTemplateDetailFileSchema).max(DESKTOP_TEMPLATE_LIMITS.maxFiles),
    exclusions: z.array(desktopTemplateExclusionSchema).max(500),
    redactions: z.array(desktopTemplateRedactionSchema).max(50),
    strippedConfigKeys: z.array(z.string().min(1).max(200)).max(100),
    // Original manifest names, always empty: env values and MCP auth never travel.
    envKeys: z.array(z.string()).max(0),
    mcpAuth: z.array(z.string()).max(0),
})
export const desktopTemplateDetailSchema = z.strictObject({
    templateId: desktopTemplateIdSchema,
    title: z.string(),
    revision: desktopTemplateRevisionSchema,
    capturedAt: z.string(),
    proseWarning: z.literal(DESKTOP_TEMPLATE_PROSE_WARNING),
    limits: desktopTemplateLimitsSchema,
    engineCommit: z.null(),
    coworkers: z.array(desktopTemplateDetailCoworkerSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
})
export type DesktopTemplateDetail = z.infer<typeof desktopTemplateDetailSchema>

export const desktopTemplateCoworkerViewSchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    position: desktopTemplatePositionSchema.optional(),
    spaceId: z.uuid().optional(),
})
export type DesktopTemplateCoworkerView = z.infer<typeof desktopTemplateCoworkerViewSchema>

export const desktopTemplateInstallResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('installed'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
        coworkers: z.array(desktopTemplateCoworkerViewSchema),
    }),
    z.strictObject({
        status: z.literal('uncertain'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        recoverable: z.literal(true),
        created: z.array(z.strictObject({ agentId: z.uuid(), phase: z.enum(['reserved', 'folder', 'indexed', 'placed']) })),
        reason: z.string().min(1).max(400),
    }),
    z.strictObject({
        status: z.literal('recoverable'),
        requestId: desktopTemplateRequestIdSchema,
        receiptId: z.uuid(),
        recoverable: z.literal(true),
        reason: z.string().min(1).max(400),
    }),
])
export type DesktopTemplateInstallResult = z.infer<typeof desktopTemplateInstallResultSchema>

export const desktopTemplateReceiptSchema = z.strictObject({
    requestId: desktopTemplateRequestIdSchema,
    receiptId: z.uuid(),
    operation: z.enum(['create-draft', 'plan', 'capture', 'install']),
    status: z.string().min(1).max(40),
    templateId: desktopTemplateIdSchema.nullable(),
    revision: desktopTemplateRevisionSchema.nullable(),
    created: z.array(z.strictObject({
        agentId: z.uuid(),
        phase: z.enum(['reserved', 'folder', 'indexed', 'placed']),
    })),
})
export type DesktopTemplateReceipt = z.infer<typeof desktopTemplateReceiptSchema>

export const desktopTemplateOperationSchema = z.discriminatedUnion('operation', [
    z.strictObject({
        operation: z.literal('create-draft'),
        requestId: desktopTemplateRequestIdSchema,
        title: z.string().trim().min(1).max(DESKTOP_TEMPLATE_LIMITS.maxTitleLength),
    }),
    z.strictObject({ operation: z.literal('sources') }),
    z.strictObject({
        operation: z.literal('plan'),
        requestId: desktopTemplateRequestIdSchema,
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
        agentIds: z.array(z.uuid()).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
    }),
    z.strictObject({
        operation: z.literal('capture'),
        requestId: desktopTemplateRequestIdSchema,
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
        planRevision: desktopTemplateRevisionSchema,
        selections: z.array(desktopTemplateSelectionSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
    }),
    z.strictObject({ operation: z.literal('list') }),
    z.strictObject({
        operation: z.literal('detail'),
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema.optional(),
    }),
    z.strictObject({
        operation: z.literal('install'),
        requestId: desktopTemplateRequestIdSchema,
        templateId: desktopTemplateIdSchema,
        revision: desktopTemplateRevisionSchema,
        spaceId: z.uuid(),
        positions: z.array(desktopTemplatePositionSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
    }),
    z.strictObject({
        operation: z.literal('receipt'),
        requestId: desktopTemplateRequestIdSchema,
    }),
])
export type DesktopTemplateOperation = z.infer<typeof desktopTemplateOperationSchema>

// C's import initializer. Idempotent for this exact trusted identity. The browser never supplies engineAgentId.
export const desktopTemplateImportedSetupSchema = z.strictObject({
    agentId: z.uuid(),
    engineAgentId: z.string().regex(/^i[a-f0-9]{31}$/),
    importReceiptId: z.uuid(),
    prompt: z.string().max(DESKTOP_TEMPLATE_LIMITS.maxFileBytes),
    required: z.boolean(),
})
export type DesktopTemplateImportedSetupInput = z.infer<typeof desktopTemplateImportedSetupSchema>
export type InitializeImportedSetup = (
    input: DesktopTemplateImportedSetupInput & { signal?: AbortSignal },
) => Promise<{ revision: string }>

export const desktopTemplateCommitCoworkerSchema = z.strictObject({
    agentId: z.uuid(),
    engineAgentId: z.string().regex(/^i[a-f0-9]{31}$/),
    name: z.string().min(1).max(60),
    description: z.string().max(2_000),
    position: desktopTemplatePositionSchema,
})
export const desktopTemplateCommitInputSchema = z.strictObject({
    requestId: desktopTemplateRequestIdSchema,
    receiptId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    spaceId: z.uuid(),
    coworkers: z.array(desktopTemplateCommitCoworkerSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
})
export type DesktopTemplateCommitInput = z.infer<typeof desktopTemplateCommitInputSchema>
export type DesktopTemplateCommit = (
    input: DesktopTemplateCommitInput & { signal?: AbortSignal },
) => Promise<{ acknowledged: true }>
