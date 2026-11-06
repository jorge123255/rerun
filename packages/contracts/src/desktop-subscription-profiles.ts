import { z } from 'zod'
import { desktopWorkspaceIdSchema } from './desktop-workspaces.js'

/** Subscription profile identity. Not an API-key connection and not a second token store. */
export const DESKTOP_SUBSCRIPTION_PROFILES_CONTRACT_VERSION = 1 as const
export const DESKTOP_SUBSCRIPTION_PROFILE_PROVIDERS = ['chatgpt', 'claude'] as const
export const desktopSubscriptionProfileProviderSchema = z.enum(DESKTOP_SUBSCRIPTION_PROFILE_PROVIDERS)
export type DesktopSubscriptionProfileProvider = z.infer<typeof desktopSubscriptionProfileProviderSchema>

export const DESKTOP_CHATGPT_CONNECTION_ID = 'mac-chatgpt' as const
export const DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID = 'mac-claude' as const

export const desktopSubscriptionProfileIdSchema = z.string().regex(/^spr_(?:builtin_chatgpt|builtin_claude|[a-z0-9-]{8,80})$/)
export type DesktopSubscriptionProfileId = z.infer<typeof desktopSubscriptionProfileIdSchema>
export const desktopSubscriptionCredentialGenerationSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,17}|rev_[a-z0-9-]{8,80}|gen_[1-9][0-9]{0,17})$/)
export type DesktopSubscriptionCredentialGeneration = z.infer<typeof desktopSubscriptionCredentialGenerationSchema>
export const desktopSubscriptionRequestIdSchema = z.uuid()
export const desktopSubscriptionProfileNameSchema = z.string().trim().min(1).max(120)

export const desktopSubscriptionPendingRunSchema = z.strictObject({
    runId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    connectionId: z.enum([DESKTOP_CHATGPT_CONNECTION_ID, DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID]),
    connectionRevision: desktopSubscriptionCredentialGenerationSchema,
    status: z.enum(['pending', 'running', 'stopping', 'unknown']),
})
export type DesktopSubscriptionPendingRun = z.infer<typeof desktopSubscriptionPendingRunSchema>

export const desktopSubscriptionAdapterCapabilitySchema = z.strictObject({
    provider: desktopSubscriptionProfileProviderSchema,
    canonicalConnectionId: z.enum([DESKTOP_CHATGPT_CONNECTION_ID, DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID]),
    independentSessions: z.literal(false),
    maxAuthenticatedSessions: z.literal(1),
    additionalProfileExecution: z.literal('blocked'),
    reason: z.string().min(1).max(400),
})
export type DesktopSubscriptionAdapterCapability = z.infer<typeof desktopSubscriptionAdapterCapabilitySchema>

export const desktopSubscriptionProfileViewSchema = z.strictObject({
    version: z.literal(DESKTOP_SUBSCRIPTION_PROFILES_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    profileId: desktopSubscriptionProfileIdSchema,
    provider: desktopSubscriptionProfileProviderSchema,
    displayName: desktopSubscriptionProfileNameSchema,
    connectionId: z.enum([DESKTOP_CHATGPT_CONNECTION_ID, DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID]).nullable(),
    credentialGeneration: desktopSubscriptionCredentialGenerationSchema.nullable(),
    /** Key or flag presence is not authentication and not provider readiness. */
    credentialMetadataPresent: z.boolean(),
    providerReady: z.literal(false),
    availability: z.enum(['current-session', 'unavailable']),
    selectable: z.boolean(),
    reason: z.string().min(1).max(400).optional(),
})
export type DesktopSubscriptionProfileView = z.infer<typeof desktopSubscriptionProfileViewSchema>

export const desktopSubscriptionProfileCatalogSchema = z.strictObject({
    version: z.literal(DESKTOP_SUBSCRIPTION_PROFILES_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    capabilities: z.array(desktopSubscriptionAdapterCapabilitySchema).length(2),
    profiles: z.array(desktopSubscriptionProfileViewSchema).max(64),
    explicitSelections: z.array(z.strictObject({
        provider: desktopSubscriptionProfileProviderSchema,
        profileId: desktopSubscriptionProfileIdSchema,
        connectionId: z.enum([DESKTOP_CHATGPT_CONNECTION_ID, DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID]),
        credentialGeneration: desktopSubscriptionCredentialGenerationSchema.nullable(),
    })).max(2),
})
export type DesktopSubscriptionProfileCatalog = z.infer<typeof desktopSubscriptionProfileCatalogSchema>

export const desktopSubscriptionExecutionSnapshotSchema = z.strictObject({
    version: z.literal(DESKTOP_SUBSCRIPTION_PROFILES_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    ownerId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    provider: desktopSubscriptionProfileProviderSchema,
    profileId: desktopSubscriptionProfileIdSchema,
    connectionId: z.enum([DESKTOP_CHATGPT_CONNECTION_ID, DESKTOP_CLAUDE_SUBSCRIPTION_CONNECTION_ID]),
    credentialGeneration: desktopSubscriptionCredentialGenerationSchema,
    runId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    capturedAt: z.string().datetime({ offset: true }),
})
export type DesktopSubscriptionExecutionSnapshot = z.infer<typeof desktopSubscriptionExecutionSnapshotSchema>

export const desktopSubscriptionSelectInputSchema = z.strictObject({
    requestId: desktopSubscriptionRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    ownerId: z.string().min(1).max(200),
    profileId: desktopSubscriptionProfileIdSchema,
    expectedGeneration: desktopSubscriptionCredentialGenerationSchema.nullable(),
})
export type DesktopSubscriptionSelectInput = z.infer<typeof desktopSubscriptionSelectInputSchema>

export const desktopSubscriptionNameInputSchema = z.strictObject({
    requestId: desktopSubscriptionRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    ownerId: z.string().min(1).max(200),
    provider: desktopSubscriptionProfileProviderSchema,
    displayName: desktopSubscriptionProfileNameSchema,
})
export type DesktopSubscriptionNameInput = z.infer<typeof desktopSubscriptionNameInputSchema>

export const desktopSubscriptionRemoveInputSchema = z.strictObject({
    requestId: desktopSubscriptionRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    ownerId: z.string().min(1).max(200),
    profileId: desktopSubscriptionProfileIdSchema,
    expectedGeneration: desktopSubscriptionCredentialGenerationSchema.nullable(),
})
export type DesktopSubscriptionRemoveInput = z.infer<typeof desktopSubscriptionRemoveInputSchema>

export const desktopSubscriptionCaptureInputSchema = z.strictObject({
    requestId: desktopSubscriptionRequestIdSchema,
    workspaceId: desktopWorkspaceIdSchema,
    ownerId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    profileId: desktopSubscriptionProfileIdSchema,
    runId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
})
export type DesktopSubscriptionCaptureInput = z.infer<typeof desktopSubscriptionCaptureInputSchema>

export const desktopSubscriptionMutationStatusSchema = z.enum(['saved', 'refused', 'uncertain'])
export type DesktopSubscriptionMutationStatus = z.infer<typeof desktopSubscriptionMutationStatusSchema>

export const desktopSubscriptionMutationReceiptSchema = z.strictObject({
    version: z.literal(DESKTOP_SUBSCRIPTION_PROFILES_CONTRACT_VERSION),
    requestId: desktopSubscriptionRequestIdSchema,
    kind: z.enum(['name', 'select', 'remove', 'capture', 'generation']),
    status: desktopSubscriptionMutationStatusSchema,
    workspaceId: desktopWorkspaceIdSchema,
    profileId: desktopSubscriptionProfileIdSchema.nullable(),
    credentialGeneration: desktopSubscriptionCredentialGenerationSchema.nullable(),
    message: z.string().min(1).max(500),
    createdAt: z.string().datetime({ offset: true }),
})
export type DesktopSubscriptionMutationReceipt = z.infer<typeof desktopSubscriptionMutationReceiptSchema>

export const SUBSCRIPTION_PROFILE_LIMIT = 'This desktop adapter keeps one authenticated session. Another profile cannot be selected for execution.'
export const SUBSCRIPTION_PROFILE_DRAIN = 'Removal drain authority is unavailable.'
export const SUBSCRIPTION_PROFILE_PENDING = 'Stop the pending runs before removing this session.'
export const SUBSCRIPTION_PROFILE_UNKNOWN = 'The session stop was not confirmed. It was not tried again.'
export const SUBSCRIPTION_PROFILE_BOUND = 'This run stays on the account it started with.'
export const SUBSCRIPTION_PROFILE_NOT_READY = 'A saved profile is not a signed-in provider session.'
