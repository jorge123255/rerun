import { z } from 'zod'
import { desktopWorkspaceIdSchema } from './desktop-workspaces.js'
import { connectionUsageSchema } from './connection.js'

export const DESKTOP_API_CONNECTIONS_CONTRACT_VERSION = 1 as const
export const DESKTOP_API_CONNECTION_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const
export const desktopApiConnectionProviderSchema = z.enum(DESKTOP_API_CONNECTION_PROVIDERS)
export type DesktopApiConnectionProvider = z.infer<typeof desktopApiConnectionProviderSchema>

export const desktopApiConnectionIdSchema = z.string().regex(/^cnx_[a-z0-9-]{8,80}$/)
export type DesktopApiConnectionId = z.infer<typeof desktopApiConnectionIdSchema>
export const desktopApiConnectionReferenceSchema = z.string().min(1).max(200)
export const desktopApiConnectionRevisionSchema = z.string().regex(/^rev_[a-z0-9-]{8,80}$/)
export type DesktopApiConnectionRevision = z.infer<typeof desktopApiConnectionRevisionSchema>
export const desktopApiMutationRequestIdSchema = z.uuid()
export const desktopApiConnectionNameSchema = z.string().trim().min(1).max(120)
export const desktopApiConnectionSecretSchema = z.string().trim().min(1).max(4096)

export const desktopApiDefaultModelSchema = z.strictObject({
    connectionId: desktopApiConnectionReferenceSchema,
    model: z.string().min(1).max(300),
    reasoningEffort: z.string().min(1).max(100).optional(),
})
export type DesktopApiDefaultModel = z.infer<typeof desktopApiDefaultModelSchema>

export const desktopApiConnectionViewSchema = z.strictObject({
    version: z.literal(DESKTOP_API_CONNECTIONS_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema,
    revision: desktopApiConnectionRevisionSchema,
    provider: desktopApiConnectionProviderSchema,
    name: desktopApiConnectionNameSchema,
    models: z.array(z.string().min(1).max(300)).max(256),
    extraModels: z.array(z.string().min(1).max(300)).max(256),
    baseUrl: z.url().or(z.literal('')).optional(),
    connected: z.boolean(),
    credentialRejected: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
})
export type DesktopApiConnectionView = z.infer<typeof desktopApiConnectionViewSchema>

export const desktopApiConnectionCatalogSchema = z.strictObject({
    version: z.literal(DESKTOP_API_CONNECTIONS_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    connections: z.array(desktopApiConnectionViewSchema).max(256),
    default: desktopApiDefaultModelSchema.nullable(),
})
export type DesktopApiConnectionCatalog = z.infer<typeof desktopApiConnectionCatalogSchema>

export const desktopApiExecutionSnapshotSchema = z.strictObject({
    version: z.literal(DESKTOP_API_CONNECTIONS_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema,
    connectionRevision: desktopApiConnectionRevisionSchema,
    provider: desktopApiConnectionProviderSchema,
    model: z.string().min(1).max(300),
    reasoningEffort: z.string().min(1).max(100).optional(),
    baseUrl: z.url().or(z.literal('')).optional(),
    allowedModelIds: z.array(z.string().min(1).max(300)).min(1).max(256),
    source: z.enum(['workspace', 'coworker', 'conversation', 'foreman', 'auxiliary']),
    runId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    capturedAt: z.string().datetime({ offset: true }),
})
export type DesktopApiExecutionSnapshot = z.infer<typeof desktopApiExecutionSnapshotSchema>

export const desktopApiCreateInputSchema = z.strictObject({
    requestId: desktopApiMutationRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    provider: desktopApiConnectionProviderSchema,
    name: desktopApiConnectionNameSchema,
    models: z.array(z.string().min(1).max(300)).max(256).default([]),
    extraModels: z.array(z.string().min(1).max(300)).max(256).default([]),
    baseUrl: z.url().or(z.literal('')).optional(),
    secret: desktopApiConnectionSecretSchema,
})
export type DesktopApiCreateInput = z.infer<typeof desktopApiCreateInputSchema>

export const desktopApiRenameInputSchema = z.strictObject({
    requestId: desktopApiMutationRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema,
    expectedRevision: desktopApiConnectionRevisionSchema,
    name: desktopApiConnectionNameSchema,
})
export type DesktopApiRenameInput = z.infer<typeof desktopApiRenameInputSchema>

export const desktopApiModelsInputSchema = z.strictObject({
    requestId: desktopApiMutationRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema,
    expectedRevision: desktopApiConnectionRevisionSchema,
    models: z.array(z.string().min(1).max(300)).max(256),
    extraModels: z.array(z.string().min(1).max(300)).max(256),
    expectedDefault: desktopApiDefaultModelSchema.nullable().optional(),
})
export type DesktopApiModelsInput = z.infer<typeof desktopApiModelsInputSchema>

export const desktopApiCredentialInputSchema = z.strictObject({
    requestId: desktopApiMutationRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema,
    expectedRevision: desktopApiConnectionRevisionSchema,
    secret: desktopApiConnectionSecretSchema,
})
export type DesktopApiCredentialInput = z.infer<typeof desktopApiCredentialInputSchema>

export const desktopApiSelectInputSchema = desktopApiDefaultModelSchema.extend({
    requestId: desktopApiMutationRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    expectedRevision: desktopApiConnectionRevisionSchema,
    source: z.enum(['workspace', 'coworker', 'conversation', 'foreman', 'auxiliary']),
    runId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
}).strict()
export type DesktopApiSelectInput = z.infer<typeof desktopApiSelectInputSchema>

export const desktopApiRemoveInputSchema = z.strictObject({
    requestId: desktopApiMutationRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema,
    expectedRevision: desktopApiConnectionRevisionSchema,
})
export type DesktopApiRemoveInput = z.infer<typeof desktopApiRemoveInputSchema>

export const desktopApiPendingRunSchema = z.strictObject({
    runId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    connectionId: desktopApiConnectionIdSchema,
    connectionRevision: desktopApiConnectionRevisionSchema,
    status: z.enum(['pending', 'running', 'stopping', 'unknown']),
})
export type DesktopApiPendingRun = z.infer<typeof desktopApiPendingRunSchema>

export const desktopApiRemovalPlanSchema = z.strictObject({
    version: z.literal(DESKTOP_API_CONNECTIONS_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema,
    connectionRevision: desktopApiConnectionRevisionSchema,
    connection: desktopApiConnectionViewSchema,
    usage: connectionUsageSchema,
    pendingRuns: z.array(desktopApiPendingRunSchema).max(256),
    preservedConnectionIds: z.array(desktopApiConnectionIdSchema).max(256),
    canRemove: z.boolean(),
    reason: z.string().max(400).optional(),
})
export type DesktopApiRemovalPlan = z.infer<typeof desktopApiRemovalPlanSchema>

export const DESKTOP_API_MUTATION_KINDS = ['create', 'rename', 'models', 'credential', 'select', 'remove'] as const
export const desktopApiMutationKindSchema = z.enum(DESKTOP_API_MUTATION_KINDS)
export type DesktopApiMutationKind = z.infer<typeof desktopApiMutationKindSchema>
export const desktopApiMutationStatusSchema = z.enum(['saved', 'refused', 'uncertain'])
export type DesktopApiMutationStatus = z.infer<typeof desktopApiMutationStatusSchema>

export const desktopApiMutationReceiptSchema = z.strictObject({
    version: z.literal(DESKTOP_API_CONNECTIONS_CONTRACT_VERSION),
    requestId: desktopApiMutationRequestIdSchema,
    kind: desktopApiMutationKindSchema,
    status: desktopApiMutationStatusSchema,
    workspaceId: desktopWorkspaceIdSchema,
    connectionId: desktopApiConnectionIdSchema.nullable(),
    connectionRevision: desktopApiConnectionRevisionSchema.nullable(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    message: z.string().min(1).max(500),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
})
export type DesktopApiMutationReceipt = z.infer<typeof desktopApiMutationReceiptSchema>

export const desktopApiRemovalResultSchema = z.strictObject({
    released: connectionUsageSchema,
    preservedConnectionIds: z.array(desktopApiConnectionIdSchema).max(256),
})
export type DesktopApiRemovalResult = z.infer<typeof desktopApiRemovalResultSchema>

export const desktopApiMutationResultSchema = z.strictObject({
    status: desktopApiMutationStatusSchema,
    recovered: z.boolean(),
    receipt: desktopApiMutationReceiptSchema,
    connection: desktopApiConnectionViewSchema.nullable(),
    catalog: desktopApiConnectionCatalogSchema.optional(),
    removal: desktopApiRemovalResultSchema.optional(),
})
export type DesktopApiMutationResult = z.infer<typeof desktopApiMutationResultSchema>

export function desktopApiCanonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Connection fingerprint value is not JSON.')
        return value
    }
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        const output: Record<string, unknown> = {}
        for (const key of Object.keys(record).sort()) if (record[key] !== undefined) output[key] = canonicalize(record[key])
        return output
    }
    throw new Error('Connection fingerprint value is not JSON.')
}
