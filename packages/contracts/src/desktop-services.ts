import { z } from 'zod'

import {
    agentServiceStatusSchema,
    authMethodSummarySchema,
    pendingAuthSchema,
    SERVICE_CATEGORIES,
    SERVICE_INSTANCE_ID_RE,
    serviceSearchResultSchema,
} from './service.js'

export {
    agentServiceStatusSchema,
    authMethodSummarySchema,
    installResultSchema,
    installedServiceSchema,
    pendingAuthSchema,
    resetConnectionSchema,
    SERVICE_CATEGORIES,
    SERVICE_CATEGORY_LABELS,
    SERVICE_INSTANCE_ID_RE,
    isServiceRegistryKey,
    parseServiceRegistryKey,
    serviceRegistryKey,
    serviceSearchResultSchema,
    type AgentServiceStatus,
    type AuthMethodSummary,
    type InstallResultView,
    type InstalledServiceView,
    type PendingAuth,
    type ResetConnectionView,
    type ServiceCategory,
    type ServiceSearchResultView,
} from './service.js'

// Team-badge and form metadata only. `verified` is not a connection check, and a catalog row is never installed.
export const desktopServiceMethodAvailabilitySchema = z.strictObject({
    id: z.string().min(1),
    supported: z.boolean(),
    reason: z.string().min(1).optional(),
})
export type DesktopServiceMethodAvailability = z.infer<typeof desktopServiceMethodAvailabilitySchema>

// E sets this after a real local probe. The catalog itself never reports healthy.
export const desktopServiceHealthSchema = z.strictObject({
    state: z.enum(['unchecked', 'healthy', 'error', 'disconnected']),
    checkedAt: z.string().min(1).optional(),
    toolCount: z.number().int().nonnegative().optional(),
    message: z.string().optional(),
})
export type DesktopServiceHealth = z.infer<typeof desktopServiceHealthSchema>

export const DESKTOP_SERVICE_HEALTH_UNCHECKED: DesktopServiceHealth = { state: 'unchecked' }

// Original installed view, with the desktop identity fields required. No mcp templates, header values, or OAuth secrets.
export const desktopInstalledServiceSchema = z.strictObject({
    key: z.string().min(1),
    slug: z.string().min(1),
    instanceId: z.string().regex(SERVICE_INSTANCE_ID_RE).optional(),
    label: z.string().optional(),
    name: z.string(),
    icon: z.string().nullable(),
    category: z.string(),
    status: agentServiceStatusSchema,
    toolNames: z.array(z.string()),
    authMethodId: z.string().optional(),
    installedAt: z.string().min(1),
    revision: z.string().min(1),
    health: desktopServiceHealthSchema,
})
export type DesktopInstalledServiceView = z.infer<typeof desktopInstalledServiceSchema>

export const desktopServiceCatalogEntrySchema = serviceSearchResultSchema.extend({
    paidApp: z.boolean().optional(),
    availability: z.array(desktopServiceMethodAvailabilitySchema).min(1),
})
export type DesktopServiceCatalogEntry = z.infer<typeof desktopServiceCatalogEntrySchema>

export const desktopServiceCatalogPageSchema = z.strictObject({
    services: z.array(desktopServiceCatalogEntrySchema),
    total: z.number().int().nonnegative(),
})
export type DesktopServiceCatalogPage = z.infer<typeof desktopServiceCatalogPageSchema>

// Client details follow ServiceDetails, always disconnected: no connect targets and no instances.
export const desktopServiceDetailsSchema = z.strictObject({
    key: z.string().min(1),
    slug: z.string().min(1),
    label: z.string().optional(),
    name: z.string(),
    category: z.string(),
    summary: z.string(),
    description: z.string(),
    icon: z.string().nullable(),
    verified: z.boolean(),
    authMethods: z.array(authMethodSummarySchema).min(1),
    availability: z.array(desktopServiceMethodAvailabilitySchema).min(1),
    installed: z.literal(false),
    installStatus: z.null(),
    multiInstance: z.boolean(),
    instances: z.array(z.never()),
    paidApp: z.boolean().optional(),
})
export type DesktopServiceDetails = z.infer<typeof desktopServiceDetailsSchema>

export const desktopServiceCatalogQuerySchema = z.strictObject({
    query: z.string().optional(),
    category: z.enum(SERVICE_CATEGORIES).optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).optional(),
})
export type DesktopServiceCatalogQuery = z.infer<typeof desktopServiceCatalogQuerySchema>

// E's POST body. Catalog code does not accept or perform these actions.
export const desktopServiceMutationSchema = z.discriminatedUnion('action', [
    z.strictObject({
        action: z.literal('install'),
        requestId: z.string().min(1),
        slug: z.string().min(1),
        authMethodId: z.string().min(1),
        values: z.record(z.string(), z.string()),
    }),
    z.strictObject({
        action: z.literal('probe'),
        requestId: z.string().min(1),
        key: z.string().min(1),
        expectedRevision: z.string().min(1),
    }),
    z.strictObject({
        action: z.literal('disconnect'),
        requestId: z.string().min(1),
        key: z.string().min(1),
        expectedRevision: z.string().min(1),
    }),
    z.strictObject({
        action: z.literal('remove'),
        requestId: z.string().min(1),
        key: z.string().min(1),
        expectedRevision: z.string().min(1),
    }),
])
export type DesktopServiceMutation = z.infer<typeof desktopServiceMutationSchema>

export const desktopServiceReadSchema = z.discriminatedUnion('view', [
    z.strictObject({
        view: z.literal('catalog'),
        query: z.string().optional(),
        category: z.enum(SERVICE_CATEGORIES).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional(),
    }),
    z.strictObject({ view: z.literal('detail'), slug: z.string().min(1) }),
    z.strictObject({ view: z.literal('installed') }),
])
export type DesktopServiceRead = z.infer<typeof desktopServiceReadSchema>

const desktopInstallIdentity = {
    key: z.string().min(1),
    revision: z.string().min(1),
    health: desktopServiceHealthSchema,
}

// Original InstallResultView, plus the desktop key, revision, and health E must return.
export const desktopInstallResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('installed'),
        ...desktopInstallIdentity,
        slug: z.string(),
        name: z.string(),
        toolNames: z.array(z.string()),
        message: z.string(),
    }),
    z.strictObject({
        status: z.literal('needs_config'),
        ...desktopInstallIdentity,
        slug: z.string(),
        name: z.string(),
        authMethods: z.array(authMethodSummarySchema),
        authMethodId: z.string().optional(),
        message: z.string(),
    }),
    z.strictObject({
        status: z.literal('needs_auth'),
        ...desktopInstallIdentity,
        slug: z.string(),
        name: z.string(),
        pendingAuth: pendingAuthSchema,
        connectUrl: z.string(),
        message: z.string(),
    }),
])
export type DesktopInstallResultView = z.infer<typeof desktopInstallResultSchema>
