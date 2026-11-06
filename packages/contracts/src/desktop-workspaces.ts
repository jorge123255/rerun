import { z } from 'zod'

/** Canonical local single-user workspace identity and transition contract (W1 local). */
export const DESKTOP_WORKSPACES_CONTRACT_VERSION = 1 as const

/** Matches original `WORKSPACE_NAME_MAX` / desktop settings. */
export const DESKTOP_WORKSPACE_NAME_MAX = 60
export const DEFAULT_DESKTOP_WORKSPACE_NAME = 'My workspace'
/** Existing Mac install always owns this id and its on-disk paths. */
export const LEGACY_DESKTOP_WORKSPACE_ID = 1 as const

export const desktopWorkspaceIdSchema = z.number().int().positive().max(1_000_000)
export type DesktopWorkspaceId = z.infer<typeof desktopWorkspaceIdSchema>

export const desktopWorkspaceNameSchema = z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(DESKTOP_WORKSPACE_NAME_MAX, `Keep the name under ${DESKTOP_WORKSPACE_NAME_MAX} characters`)

/** Catalog illustration id = bundled file name under public/workspace-icons. */
export const desktopWorkspaceIconCatalogIdSchema = z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/, 'Unknown workspace icon')

export const desktopWorkspaceRecordSchema = z.strictObject({
    workspaceId: desktopWorkspaceIdSchema,
    name: desktopWorkspaceNameSchema,
    iconCatalogId: desktopWorkspaceIconCatalogIdSchema.nullable(),
    /** Exclusive owned directory name under `{dataRoot}/workspaces/` — always the decimal id. */
    directoryName: z.string().regex(/^[1-9][0-9]*$/),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    /** Path health relative to the install; never auto-healed by a read. */
    pathStatus: z.enum(['ready', 'missing', 'corrupt', 'foreign']),
})
export type DesktopWorkspaceRecord = z.infer<typeof desktopWorkspaceRecordSchema>

export const desktopWorkspaceCatalogSchema = z.strictObject({
    version: z.literal(DESKTOP_WORKSPACES_CONTRACT_VERSION),
    installId: z.string().uuid(),
    workspaces: z.array(desktopWorkspaceRecordSchema).min(1),
})
export type DesktopWorkspaceCatalog = z.infer<typeof desktopWorkspaceCatalogSchema>

export const desktopWorkspaceSelectionSchema = z.strictObject({
    version: z.literal(DESKTOP_WORKSPACES_CONTRACT_VERSION),
    workspaceId: desktopWorkspaceIdSchema,
    /** Switch receipt that last published this selection; null for the seeded legacy workspace. */
    publishedByReceiptId: z.string().uuid().nullable(),
    selectedAt: z.string().datetime({ offset: true }),
})
export type DesktopWorkspaceSelection = z.infer<typeof desktopWorkspaceSelectionSchema>

/**
 * Durable switch phases. Ordering is irreversible after `old_runtime_closed`:
 * rollback before that phase restores the previous selection; after it, recovery
 * must finish starting the target or surface a blocked state — never silently
 * reopen the drained runtime under a different identity.
 */
export const desktopWorkspaceSwitchPhaseSchema = z.enum([
    'accepted',
    'admissions_frozen',
    'drafts_flushed',
    'work_drained',
    'old_runtime_closed',
    'target_starting',
    'identity_verified',
    'published',
    'failed_before_drain',
    'failed_after_drain',
    'rolled_back',
    'cancelled',
])
export type DesktopWorkspaceSwitchPhase = z.infer<typeof desktopWorkspaceSwitchPhaseSchema>

export const desktopWorkspaceSwitchReceiptSchema = z.strictObject({
    version: z.literal(DESKTOP_WORKSPACES_CONTRACT_VERSION),
    receiptId: z.string().uuid(),
    requestId: z.string().uuid(),
    fromWorkspaceId: desktopWorkspaceIdSchema,
    toWorkspaceId: desktopWorkspaceIdSchema,
    phase: desktopWorkspaceSwitchPhaseSchema,
    /** Exact install that accepted the switch. */
    installId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    /** Product-language reason when failed/cancelled; never a stack trace. */
    reason: z.string().max(400).nullable(),
    /** True once admissions were frozen for this receipt (blocks concurrent switches). */
    admissionsFrozen: z.boolean(),
    /** True once the old runtime drain completed for this receipt. */
    oldRuntimeClosed: z.boolean(),
})
export type DesktopWorkspaceSwitchReceipt = z.infer<typeof desktopWorkspaceSwitchReceiptSchema>

export const desktopWorkspaceCreateInputSchema = z.strictObject({
    requestId: z.string().uuid(),
    name: desktopWorkspaceNameSchema,
    iconCatalogId: desktopWorkspaceIconCatalogIdSchema.nullable().default(null),
})
export type DesktopWorkspaceCreateInput = z.infer<typeof desktopWorkspaceCreateInputSchema>

export const desktopWorkspaceRenameInputSchema = z.strictObject({
    requestId: z.string().uuid(),
    workspaceId: desktopWorkspaceIdSchema,
    name: desktopWorkspaceNameSchema,
    iconCatalogId: desktopWorkspaceIconCatalogIdSchema.nullable().optional(),
})
export type DesktopWorkspaceRenameInput = z.infer<typeof desktopWorkspaceRenameInputSchema>

export const desktopWorkspaceSwitchInputSchema = z.strictObject({
    requestId: z.string().uuid(),
    workspaceId: desktopWorkspaceIdSchema,
})
export type DesktopWorkspaceSwitchInput = z.infer<typeof desktopWorkspaceSwitchInputSchema>

export const desktopWorkspaceRefusalCodeSchema = z.enum([
    'not_found',
    'name_required',
    'name_too_long',
    'unknown_icon',
    'duplicate_request',
    'path_missing',
    'path_corrupt',
    'path_foreign',
    'busy',
    'admissions_frozen',
    'draft_flush_failed',
    'drain_failed',
    'runtime_close_failed',
    'runtime_start_failed',
    'identity_mismatch',
    'cancelled',
    'authority_missing',
    'unsupported',
    'quit_in_progress',
])
export type DesktopWorkspaceRefusalCode = z.infer<typeof desktopWorkspaceRefusalCodeSchema>

export const desktopWorkspaceRefusalSchema = z.strictObject({
    ok: z.literal(false),
    code: desktopWorkspaceRefusalCodeSchema,
    /** Normal product language for toasts and dialogs. */
    message: z.string().min(1).max(400),
    /** Named missing root authority when code is authority_missing. */
    authority: z.string().max(120).optional(),
})
export type DesktopWorkspaceRefusal = z.infer<typeof desktopWorkspaceRefusalSchema>

export const desktopWorkspaceCreateResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({
        ok: z.literal(true),
        workspace: desktopWorkspaceRecordSchema,
        /** Create never auto-switches; the caller may request a switch with this id. */
        switched: z.literal(false),
    }),
    desktopWorkspaceRefusalSchema,
])
export type DesktopWorkspaceCreateResult = z.infer<typeof desktopWorkspaceCreateResultSchema>

export const desktopWorkspaceRenameResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), workspace: desktopWorkspaceRecordSchema }),
    desktopWorkspaceRefusalSchema,
])
export type DesktopWorkspaceRenameResult = z.infer<typeof desktopWorkspaceRenameResultSchema>

export const desktopWorkspaceSwitchResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({
        ok: z.literal(true),
        receipt: desktopWorkspaceSwitchReceiptSchema,
        workspace: desktopWorkspaceRecordSchema,
    }),
    desktopWorkspaceRefusalSchema,
])
export type DesktopWorkspaceSwitchResult = z.infer<typeof desktopWorkspaceSwitchResultSchema>

export const desktopWorkspaceListResultSchema = z.strictObject({
    catalog: desktopWorkspaceCatalogSchema,
    selection: desktopWorkspaceSelectionSchema,
    /** Non-effectful: in-flight receipt if a prior switch was interrupted. */
    openReceipt: desktopWorkspaceSwitchReceiptSchema.nullable(),
})
export type DesktopWorkspaceListResult = z.infer<typeof desktopWorkspaceListResultSchema>

/** Provider preference keys that may be deliberately shared across local workspaces. Default: none. */
export const desktopWorkspaceSharedPreferenceKeys = [
    // Intentionally empty in W1 local: isolation is the default. Root may opt in later
    // (for example a non-secret UI theme preference) without migrating live secrets.
] as const
export type DesktopWorkspaceSharedPreferenceKey = (typeof desktopWorkspaceSharedPreferenceKeys)[number]

/** Isolation domains that must not leak across local workspaces. */
export const desktopWorkspaceIsolationDomains = [
    'engine_root',
    'app_database',
    'chats_and_sessions',
    'grants',
    'browser_sessions',
    'documents',
    'local_mcp',
    'templates',
    'brain_memory',
    'provider_credentials',
    'foreman_state',
    'drafts',
    'board_layout',
    'schedules',
    'services_accounts',
] as const
export type DesktopWorkspaceIsolationDomain = (typeof desktopWorkspaceIsolationDomains)[number]
