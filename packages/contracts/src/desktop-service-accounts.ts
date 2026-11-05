import { z } from 'zod'

import { inputDefSchema } from './input.js'
import {
    desktopInstalledServiceSchema,
    desktopServiceMethodAvailabilitySchema,
    SERVICE_INSTANCE_ID_RE,
    isServiceRegistryKey,
    parseServiceRegistryKey,
    serviceRegistryKey,
    type DesktopInstalledServiceView,
    type DesktopServiceHealth,
    type DesktopServiceMethodAvailability,
} from './desktop-services.js'

export {
    SERVICE_INSTANCE_ID_RE,
    isServiceRegistryKey,
    parseServiceRegistryKey,
    serviceRegistryKey,
    type DesktopInstalledServiceView,
    type DesktopServiceHealth,
    type DesktopServiceMethodAvailability,
}

/** Live install rows per coworker. Matches the canonical service table ceiling. */
export const DESKTOP_SERVICE_ACCOUNT_LIMIT = 64

export const DESKTOP_SERVICE_ACCOUNT_LIMIT_MESSAGE =
    'This coworker already has 64 service accounts. Remove one before adding another.'

/**
 * Safe strings the feature may return. Anything else is a generic refusal so a
 * header value or secret cannot ride out on an error.
 */
export const DESKTOP_SERVICE_ACCOUNT_MESSAGES = {
    reused: 'Request identity reused',
    unknown: 'Prior request acknowledgement unavailable; inspect connection state.',
    limit: DESKTOP_SERVICE_ACCOUNT_LIMIT_MESSAGE,
    notMulti: 'This app does not accept another account.',
    needBase: 'Install the app before adding an account.',
    baseExists: 'The base account already exists. Add an account or save the existing one.',
    method: 'This authentication method is unavailable on this Mac.',
    unknownService: 'Unknown service',
    revision: 'Service revision conflict',
    owner: 'Service installation belongs to a previous engine identity',
    ready: 'Existing service must be disconnected before configuring again',
    mask: 'A display mask is not a credential.',
    credential: 'A credential is required.',
    missing: 'Required setup is missing.',
    header: 'This header setup is not supported on this Mac.',
    grant: 'Enable Apps in this coworker’s Tools to check the connection.',
    removed: 'Local credentials removed. This does not revoke the remote API key.',
    probeFailed: 'Connection unavailable. Check current permission and configuration.',
    stale: 'This request completed at an earlier revision. Refresh the current installation; it will not be replayed.',
    gone: 'The original installation no longer exists. This request will not be replayed.',
    inProgress: 'Request is already in progress',
    secretConflict: 'Secret write conflict',
    unsupported: 'This method is not a supported local HTTPS header setup.',
    anonymous: 'Unsupported anonymous service configuration',
    bearer: 'A Bearer credential is required',
    binding: 'Unsupported credential binding',
    substitution: 'Unsupported secret substitution',
    endpoint: 'Only one canonical HTTPS Streamable HTTP endpoint is supported',
    hosted: 'Hosted service authority is unavailable locally',
    localMethod: 'Unsupported local service method',
    instance: 'Invalid service instance',
    skill: 'Unsupported service skill template',
    skillsUnavailable: 'Service usage-skill bundles are not available on this Mac yet.',
    headerName: 'Invalid header name',
    headerDuplicate: 'Duplicate header name',
    headerTransport: 'Header conflicts with the transport',
    headerValue: 'Invalid header value',
    unknownInput: 'Unknown input',
    missingInput: 'Missing header input',
    unknownMethod: 'Unknown authentication method.',
    unwind: 'Service installation incomplete',
    toolName: 'Service tool name exceeds limit',
    origin: 'MCP operation failed; check permission, configuration and server',
    leak: 'Secret leakage',
    cancelled: 'MCP operation cancelled or timed out',
} as const

export type DesktopServiceAccountMessage = (typeof DESKTOP_SERVICE_ACCOUNT_MESSAGES)[keyof typeof DESKTOP_SERVICE_ACCOUNT_MESSAGES]

const messageSet = new Set<string>(Object.values(DESKTOP_SERVICE_ACCOUNT_MESSAGES))

export function desktopServiceAccountMessage(error: unknown): DesktopServiceAccountMessage | null {
    const text = error instanceof Error ? error.message : ''
    return messageSet.has(text) ? (text as DesktopServiceAccountMessage) : null
}

/** Names and bindings only. Compiled values stay in the encrypted bundle. */
export const desktopServiceHeaderPlanEntrySchema = z.strictObject({
    name: z.string().min(1).max(128),
    source: z.enum(['fixed', 'input']),
    inputKeys: z.array(z.string().min(1).max(128)).max(16),
    secret: z.boolean(),
})
export type DesktopServiceHeaderPlanEntry = z.infer<typeof desktopServiceHeaderPlanEntrySchema>

/**
 * Public account view. `label` is the ordinal display name ("App 2") and is not
 * an identity. Lookup uses `key` (`slug` or `slug@instanceId`) and `installationId`.
 */
export const desktopServiceAccountViewSchema = desktopInstalledServiceSchema
    .extend({
        installationId: z.string().uuid(),
        shape: z.enum(['anonymous', 'bearer', 'headers']),
        headerPlan: z.array(desktopServiceHeaderPlanEntrySchema),
        configured: z.boolean(),
        configuredInputs: z.record(z.string().min(1).max(128), z.literal(true)),
        publicInputs: z.record(z.string().min(1).max(128), z.string().max(8192)),
    })
    .strict()
export type DesktopServiceAccountView = z.infer<typeof desktopServiceAccountViewSchema>

export const desktopServiceAccountIntentSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('new'), slug: z.string().min(1).max(200) }),
    z.strictObject({ kind: z.literal('additional'), slug: z.string().min(1).max(200) }),
    z.strictObject({
        kind: z.literal('existing'),
        accountKey: z.string().min(1).max(220),
        expectedRevision: z.string().uuid(),
    }),
])
export type DesktopServiceAccountIntent = z.infer<typeof desktopServiceAccountIntentSchema>

const valuesSchema = z.record(z.string().min(1).max(128), z.string().max(8192))

/** Wire body. Engine owner and endpoint authority are not fields here. */
export const desktopServiceAccountMutationSchema = z.discriminatedUnion('action', [
    z.strictObject({
        action: z.literal('install'),
        requestId: z.string().uuid(),
        intent: z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('new'), slug: z.string().min(1).max(200) }),
            z.strictObject({ kind: z.literal('additional'), slug: z.string().min(1).max(200) }),
        ]),
        authMethodId: z.string().min(1).max(200),
        values: valuesSchema,
    }),
    z.strictObject({
        action: z.literal('reconfigure'),
        requestId: z.string().uuid(),
        intent: z.strictObject({
            kind: z.literal('existing'),
            accountKey: z.string().min(1).max(220),
            expectedRevision: z.string().uuid(),
        }),
        authMethodId: z.string().min(1).max(200),
        values: valuesSchema,
    }),
    z.strictObject({
        action: z.enum(['probe', 'disconnect', 'remove']),
        requestId: z.string().uuid(),
        intent: z.strictObject({
            kind: z.literal('existing'),
            accountKey: z.string().min(1).max(220),
            expectedRevision: z.string().uuid(),
        }),
    }),
])
export type DesktopServiceAccountMutation = z.infer<typeof desktopServiceAccountMutationSchema>

/** Server binding. A label is not accepted as either id. */
export const desktopServiceAccountBindingSchema = z.strictObject({
    coworkerId: z.string().min(1).max(200),
    engineOwnerId: z.string().min(1).max(200),
})
export type DesktopServiceAccountBinding = z.infer<typeof desktopServiceAccountBindingSchema>

export const desktopServiceAccountResultSchema = z.strictObject({
    status: z.enum(['installed', 'needs_config', 'removed', 'disconnected', 'probed', 'unknown']),
    accountKey: z.string().min(1).optional(),
    installationId: z.string().uuid().optional(),
    revision: z.string().uuid().optional(),
    message: z.string().min(1).optional(),
    account: desktopServiceAccountViewSchema.optional(),
})
export type DesktopServiceAccountResult = z.infer<typeof desktopServiceAccountResultSchema>

export const desktopServiceAccountMethodSchema = z.strictObject({
    id: z.string(),
    label: z.string(),
    kind: z.enum(['oauth', 'key', 'stdio', 'none', 'managed', 'composio', 'app']),
    recommended: z.boolean(),
    inputs: z.array(inputDefSchema),
    requiresSecrets: z.boolean(),
    availability: desktopServiceMethodAvailabilitySchema,
})

export const DESKTOP_SERVICE_ACCOUNT_HEALTH_UNCHECKED: DesktopServiceHealth = { state: 'unchecked' }
