import { z } from 'zod'

/**
 * Canonical external-client MCP contract (W4), version 1.
 * C and D consume this file. Do not invent a second principal, key, or grant shape.
 * Workspace ids match desktop-workspaces contract version 1 `desktopWorkspaceIdSchema`
 * (positive int, max 1_000_000). This file is not a workspace catalog.
 */
export const DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION = 1 as const

export const externalMcpWorkspaceIdSchema = z.number().int().positive().max(1_000_000)
export type ExternalMcpWorkspaceId = z.infer<typeof externalMcpWorkspaceIdSchema>

export const EXTERNAL_MCP_KEY_PREFIX = 'rk_'
export const EXTERNAL_MCP_PREFIX_LENGTH = 12
export const EXTERNAL_MCP_NAME_MAX = 60
export const EXTERNAL_MCP_ACTIVE_KEY_MAX = 20
export const EXTERNAL_MCP_PATH = '/mcp'
export const EXTERNAL_MCP_REQUEST_HEADER = 'x-rerun-external-request-id'
export const EXTERNAL_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'] as const
export const EXTERNAL_MCP_DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/** Explicit scopes. Default grant is only `mcp:read`. No wildcard, admin, or credential scope exists. */
export const EXTERNAL_MCP_SCOPES = ['mcp:read', 'coworkers:write', 'schedules:write', 'triggers:write', 'connectors:write', 'runs:send', 'data:write'] as const
export const externalMcpScopeSchema = z.enum(EXTERNAL_MCP_SCOPES)
export type ExternalMcpScope = z.infer<typeof externalMcpScopeSchema>
export const EXTERNAL_MCP_DEFAULT_SCOPES = ['mcp:read'] as const satisfies readonly ExternalMcpScope[]
export const EXTERNAL_MCP_REFUSED_SCOPES = ['*', 'mcp:admin', 'credentials', 'mcp:*'] as const

export const EXTERNAL_MCP_COPY = {
    dialogTitle: 'API keys',
    dialogBody: 'Connect Claude Code or any MCP client to this workspace.',
    sectionConnect: 'Connect a client',
    sectionKeys: 'Keys',
    docsLabel: 'API keys',
    nameLabel: 'New key name',
    namePlaceholder: 'Claude Code, MacBook',
    create: 'Create key',
    revokeTitle: 'Revoke this key?',
    revoke: 'Revoke',
    revokeAria: 'Revoke this key',
    nameRequired: 'Give the key a name, so you can tell it apart later.',
    nameTooLong: `Keep the name under ${EXTERNAL_MCP_NAME_MAX} characters.`,
    tooMany: `This workspace already has ${EXTERNAL_MCP_ACTIVE_KEY_MAX} active keys. Revoke one to create another.`,
    secretDiscarded: 'This key was created, but its secret was already discarded. Revoke it and create another.',
    listenerOff: 'The local MCP listener is off.',
    unauthorized: 'Unauthorized',
    adapterMissing: 'External MCP tools are not connected.',
    changed: 'This request no longer matches the key that started it.',
    inFlight: 'That request is still unfinished. It was not started again.',
    uncertain: 'The external request outcome is unknown. It was not started again.',
    revoked: 'This key was revoked.',
    expired: 'This key is expired.',
    workspace: 'This key belongs to another workspace.',
    stopped: 'The desktop runtime is stopped.',
    frozen: 'Workspace switching has paused new external connections.',
    authorityMissing: 'The desktop workspace runtime is not bound, so this external key cannot be admitted.',
} as const

const stamp = z.string().datetime()
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)

export const externalMcpPrincipalSchema = z.strictObject({
    version: z.literal(DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION),
    keyId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
    keyRevision: z.number().int().positive(),
    scopes: z.array(externalMcpScopeSchema).min(1).max(EXTERNAL_MCP_SCOPES.length),
    installId: z.uuid(),
    launchNonce: z.uuid(),
    runtimeWorkspaceId: externalMcpWorkspaceIdSchema,
    expiresAt: stamp.nullable(),
})
export type ExternalMcpPrincipal = z.infer<typeof externalMcpPrincipalSchema>

/** The grant stored for a key. It is not a wildcard and it is not the engine credential. */
export const externalMcpGrantSchema = z.strictObject({
    version: z.literal(DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION),
    keyId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
    keyRevision: z.number().int().positive(),
    scopes: z.array(externalMcpScopeSchema).min(1).max(EXTERNAL_MCP_SCOPES.length),
})
export type ExternalMcpGrant = z.infer<typeof externalMcpGrantSchema>

export const EXTERNAL_MCP_KEY_STATUSES = ['active', 'revoked', 'expired'] as const
export const externalMcpKeyViewSchema = z.strictObject({
    version: z.literal(DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION),
    keyId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
    name: z.string().min(1).max(EXTERNAL_MCP_NAME_MAX),
    keyPrefix: z.string().length(EXTERNAL_MCP_PREFIX_LENGTH),
    scopes: z.array(externalMcpScopeSchema).min(1).max(EXTERNAL_MCP_SCOPES.length),
    status: z.enum(EXTERNAL_MCP_KEY_STATUSES),
    expiresAt: stamp.nullable(),
    revokedAt: stamp.nullable(),
    createdAt: stamp,
    lastUsedAt: stamp.nullable(),
    revision: z.number().int().positive(),
})
export type ExternalMcpKeyView = z.infer<typeof externalMcpKeyViewSchema>

export const EXTERNAL_MCP_REFUSAL_CODES = [
    'unauthorized', 'forbidden_origin', 'forbidden_host', 'forbidden_url', 'expired', 'revoked',
    'workspace_mismatch', 'runtime_stopped', 'admissions_frozen', 'revision_changed', 'scope_missing',
    'scope_refused', 'authority_missing', 'listener_disabled', 'adapter_missing', 'replay_conflict',
    'in_flight', 'uncertain', 'too_many_keys', 'name_required', 'name_too_long', 'not_found', 'unsupported', 'invalid',
] as const
export const externalMcpRefusalSchema = z.strictObject({
    ok: z.literal(false),
    code: z.enum(EXTERNAL_MCP_REFUSAL_CODES),
    message: z.string().min(1).max(400),
    /** Set when code is authority_missing. Names the root port that is not bound. */
    authority: z.string().min(1).max(120).optional(),
})
export type ExternalMcpRefusal = z.infer<typeof externalMcpRefusalSchema>

export const EXTERNAL_MCP_RECEIPT_KINDS = ['create', 'revoke', 'enable', 'disable', 'operation'] as const
export const EXTERNAL_MCP_RECEIPT_STATUSES = ['recorded', 'rejected', 'uncertain'] as const
export const externalMcpReceiptSchema = z.strictObject({
    version: z.literal(DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION),
    receiptId: z.uuid(),
    requestId: z.uuid(),
    kind: z.enum(EXTERNAL_MCP_RECEIPT_KINDS),
    status: z.enum(EXTERNAL_MCP_RECEIPT_STATUSES),
    workspaceId: externalMcpWorkspaceIdSchema,
    keyId: z.uuid().nullable(),
    keyRevision: z.number().int().positive().nullable(),
    installId: z.uuid().nullable(),
    launchNonce: z.uuid().nullable(),
    fingerprint,
    message: z.string().min(1).max(400),
    /** True only in the first create response that still holds the one-time secret. Never stored as the secret. */
    secretAvailable: z.boolean(),
    createdAt: stamp,
})
export type ExternalMcpReceipt = z.infer<typeof externalMcpReceiptSchema>

export const externalMcpCreateInputSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
    name: z.string().max(EXTERNAL_MCP_NAME_MAX + 40),
    scopes: z.array(externalMcpScopeSchema).min(1).max(EXTERNAL_MCP_SCOPES.length).default([...EXTERNAL_MCP_DEFAULT_SCOPES]),
    expiresAt: stamp.nullable().default(null),
})
export type ExternalMcpCreateInput = z.infer<typeof externalMcpCreateInputSchema>
/** Request body. `scopes` and `expiresAt` may be omitted; the output type above already applied the defaults. */
export type ExternalMcpCreateRequest = z.input<typeof externalMcpCreateInputSchema>

export const externalMcpCreateResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({
        ok: z.literal(true),
        recovered: z.boolean(),
        secretAvailable: z.boolean(),
        secret: z.string().nullable(),
        key: externalMcpKeyViewSchema,
        receipt: externalMcpReceiptSchema,
        message: z.string().min(1).max(400),
    }),
    externalMcpRefusalSchema,
])
export type ExternalMcpCreateResult = z.infer<typeof externalMcpCreateResultSchema>

export const externalMcpRevokeInputSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
    keyId: z.uuid(),
})
export type ExternalMcpRevokeInput = z.infer<typeof externalMcpRevokeInputSchema>

export const externalMcpRevokeResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), recovered: z.boolean(), key: externalMcpKeyViewSchema, receipt: externalMcpReceiptSchema }),
    externalMcpRefusalSchema,
])
export type ExternalMcpRevokeResult = z.infer<typeof externalMcpRevokeResultSchema>

export const externalMcpListResultSchema = z.strictObject({
    version: z.literal(DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION),
    workspaceId: externalMcpWorkspaceIdSchema,
    keys: z.array(externalMcpKeyViewSchema).max(EXTERNAL_MCP_ACTIVE_KEY_MAX),
})
export type ExternalMcpListResult = z.infer<typeof externalMcpListResultSchema>
export const externalMcpListResponseSchema = z.union([externalMcpListResultSchema, externalMcpRefusalSchema])
export type ExternalMcpListResponse = z.infer<typeof externalMcpListResponseSchema>

export const externalMcpListenerViewSchema = z.strictObject({
    version: z.literal(DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION),
    enabled: z.boolean(),
    origin: z.string().nullable(),
    path: z.literal(EXTERNAL_MCP_PATH),
    workspaceId: externalMcpWorkspaceIdSchema.nullable(),
    installId: z.uuid().nullable(),
    launchNonce: z.uuid().nullable(),
})
export type ExternalMcpListenerView = z.infer<typeof externalMcpListenerViewSchema>

export const externalMcpEnableInputSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
})
export type ExternalMcpEnableInput = z.infer<typeof externalMcpEnableInputSchema>

export const externalMcpListenerResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), recovered: z.boolean(), listener: externalMcpListenerViewSchema, receipt: externalMcpReceiptSchema }),
    externalMcpRefusalSchema,
])
export type ExternalMcpListenerResult = z.infer<typeof externalMcpListenerResultSchema>

export const externalMcpLiveCheckInputSchema = z.strictObject({
    requestId: z.uuid(),
    keyId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
    keyRevision: z.number().int().positive(),
    installId: z.uuid(),
    launchNonce: z.uuid(),
    scopes: z.array(externalMcpScopeSchema).min(1).max(EXTERNAL_MCP_SCOPES.length),
})
export type ExternalMcpLiveCheckInput = z.infer<typeof externalMcpLiveCheckInputSchema>

export const externalMcpLiveCheckResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), principal: externalMcpPrincipalSchema }),
    externalMcpRefusalSchema,
])
export type ExternalMcpLiveCheckResult = z.infer<typeof externalMcpLiveCheckResultSchema>

export const externalMcpToolRegistrationSchema = z.strictObject({
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(4_000),
    inputSchema: z.record(z.string(), z.unknown()),
    scope: externalMcpScopeSchema,
    effect: z.boolean(),
}).refine(tool => (tool.effect ? tool.scope !== 'mcp:read' : tool.scope === 'mcp:read'), {
    message: 'An effect tool needs an explicit write scope. A read tool is only mcp:read.',
})
export type ExternalMcpToolRegistration = z.infer<typeof externalMcpToolRegistrationSchema>

export const externalMcpCallContextSchema = z.strictObject({
    version: z.literal(DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION),
    requestId: z.uuid(),
    fingerprint,
    principal: externalMcpPrincipalSchema,
    tool: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()),
})
export type ExternalMcpCallContext = z.infer<typeof externalMcpCallContextSchema>

export const externalMcpToolResultSchema = z.strictObject({
    content: z.array(z.strictObject({ type: z.literal('text'), text: z.string().max(60_000) })).length(1),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
})
export type ExternalMcpToolResult = z.infer<typeof externalMcpToolResultSchema>

/** C registers an object of this shape. A missing adapter is a refusal, not an empty tool list. */
export type ExternalMcpDispatchPort = {
    listTools(principal: ExternalMcpPrincipal): Promise<ExternalMcpToolRegistration[]>
    callTool(context: ExternalMcpCallContext, signal: AbortSignal): Promise<ExternalMcpToolResult>
}

/** Stable JSON for fingerprints. Arrays keep their order. The secret is never part of this value. */
export function externalMcpCanonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('External MCP fingerprint value is not JSON.')
        return value
    }
    if (Array.isArray(value)) return value.map(canonicalize)
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(record).sort()) {
            if (record[key] !== undefined) out[key] = canonicalize(record[key])
        }
        return out
    }
    throw new Error('External MCP fingerprint value is not JSON.')
}

/** The only secret D may render. A hash, a recovered create, or a null secret renders nothing. */
export function externalMcpDisplayedSecret(result: { secretAvailable: boolean; secret: string | null }): string | null {
    if (!result.secretAvailable || !result.secret?.startsWith(EXTERNAL_MCP_KEY_PREFIX)) return null
    return result.secret
}
