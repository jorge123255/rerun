import { z } from 'zod'
import { MCP_SERVER_NAME_RE, mcpServerNameSchema } from './agent.js'

// ---------------------------------------------------------------------------
// Desktop self-MCP: the one canonical contract for the hosted `mcp_register`
// workflow ported to the Mac app as a proposal -> human review -> trusted local
// configuration lifecycle.
//
// The model may propose an MCP server; it can never approve its own proposal,
// grant itself execution permission, install a package, launch a local program
// or silently replace a trusted connection. Registration and tool execution
// stay distinct decisions: proposing writes no configuration and opens no
// network connection; only an explicit local human decision may probe and save.
//
// Server-only state (engine identity resolution, credential references, probe
// results) lives behind the injected UI authority/store adapters. The payloads
// in this module are strictly nonsecret: a renderer or model payload never
// establishes authority.
// ---------------------------------------------------------------------------

export const SELF_MCP_GRANT = 'selfMcpRegister' as const
/** Mirrors the engine `BRIDGE_SERVER_NAME`: a model proposal can never take it over. */
export const SELF_MCP_RESERVED_NAME = 'rerun' as const

// --- Transports -------------------------------------------------------------

export const selfMcpTransportSchema = z.enum(['stdio', 'sse', 'http'])
export type SelfMcpTransport = z.infer<typeof selfMcpTransportSchema>

// --- Exact local run identity ----------------------------------------------
// Bound at proposal time and required again at decision time: the renderer and
// the engine payload never carry authority by themselves, the decision binds
// to this identity so a late or forged answer cannot resurrect a stopped or
// replaced owner.

export const selfMcpRunIdentitySchema = z.object({
    engineAgentId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
}).strict()
export type SelfMcpRunIdentity = z.infer<typeof selfMcpRunIdentitySchema>

// --- Nonsecret candidate metadata ------------------------------------------
// Mirrors the engine `McpServer` shape (name/transport/command/args/url/env/
// headers) so the root configuration adapter can map it into whichever store,
// but validated strictly: every env/header value must be a `${NAME}` variable
// reference (a requirement, never a disclosed value), URLs must not carry
// credentials/query/fragment, and unrecognized fields are rejected before
// anything is persisted.

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
/** A pure `${NAME}` reference, used for env values. */
const PURE_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
/** A fixed template that may embed exactly one `${NAME}` reference, used for header values. */
const HEADER_TEMPLATE_RE = /^[A-Za-z0-9._~ /=-]*\$\{([A-Za-z_][A-Za-z0-9_]*)\}[A-Za-z0-9._~ /=-]*$/

export const selfMcpServerInputSchema = z.object({
    name: mcpServerNameSchema,
    transport: selfMcpTransportSchema.optional(),
    command: z.string().max(1024).optional(),
    args: z.array(z.string().max(1024)).max(64).default([]),
    url: z.string().max(2048).optional(),
    env: z.record(z.string(), z.string()).default({}),
    headers: z.record(z.string(), z.string()).default({}),
}).strict()
export type SelfMcpServerInput = z.infer<typeof selfMcpServerInputSchema>

// --- Proposal lifecycle -----------------------------------------------------

export const selfMcpProposalStatusSchema = z.enum(['pending', 'claimed', 'applied', 'rejected', 'cancelled', 'uncertain'])
export type SelfMcpProposalStatus = z.infer<typeof selfMcpProposalStatusSchema>

export const selfMcpProposalSchema = z.object({
    id: z.string().min(1).max(128),
    /** Proposal revision, bumped on every transition; decisions CAS on it. */
    revision: z.number().int().nonnegative(),
    /** Local coworker id the proposal belongs to. */
    agentId: z.string().min(1).max(128),
    identity: selfMcpRunIdentitySchema,
    /** Captured from trusted source authority, never from the model proposal. */
    launchEpoch: z.string().min(1).max(256),
    /** sha256 hex of `selfMcpCanonicalInput(input)`; same invocation reconciles one proposal. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    input: selfMcpServerInputSchema,
    /** Resolved transport (auto-detected from url/command when omitted). */
    transport: selfMcpTransportSchema,
    /** Configuration revision at proposal time; decisions CAS against it. */
    configRevision: z.number().int().nonnegative(),
    status: selfMcpProposalStatusSchema,
    createdAt: z.string().min(1),
}).strict()
export type SelfMcpProposal = z.infer<typeof selfMcpProposalSchema>

// --- Connectivity of a proposed server -------------------------------------

export const selfMcpConnectivitySchema = z.enum(['connected', 'needs_credentials', 'needs_permission', 'unverified'])
export type SelfMcpConnectivity = z.infer<typeof selfMcpConnectivitySchema>

// --- Decision request (UI -> server) ---------------------------------------

export const selfMcpDecisionOutcomeSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('approved') }).strict(),
    z.object({ kind: z.literal('rejected'), reason: z.string().trim().max(4_000).optional() }).strict(),
])
export type SelfMcpDecisionOutcome = z.infer<typeof selfMcpDecisionOutcomeSchema>

// The decision id is generated by the review client (like request ids elsewhere
// in the desktop UI) so a retried submit converges to the same result. The
// server still CAS-reserves the proposal transition; a racing second tab uses a
// different decision id and loses the CAS instead of double-applying.
export const selfMcpDecisionRequestSchema = z.object({
    proposalId: z.string().min(1).max(128),
    decisionId: z.string().min(1).max(128),
    expectedProposalRevision: z.number().int().nonnegative(),
    expectedConfigRevision: z.number().int().nonnegative(),
    outcome: selfMcpDecisionOutcomeSchema,
}).strict()
export type SelfMcpDecisionRequest = z.infer<typeof selfMcpDecisionRequestSchema>

// --- Server-side decision record -------------------------------------------

export const selfMcpDecisionSchema = z.object({
    id: z.string().min(1).max(128),
    proposalId: z.string().min(1).max(128),
    proposalRevision: z.number().int().nonnegative(),
    /** Expected config revision the decision bound itself to. */
    configRevision: z.number().int().nonnegative(),
    identity: selfMcpRunIdentitySchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: selfMcpDecisionOutcomeSchema,
    agentId: z.string().min(1).max(128),
    decidedAt: z.string().min(1),
}).strict()
export type SelfMcpDecision = z.infer<typeof selfMcpDecisionSchema>

// --- Durable operation receipt ---------------------------------------------

export const selfMcpReceiptOutcomeSchema = z.enum(['applied', 'applied_pending_credentials', 'applied_unverified', 'rejected', 'cancelled', 'failed'])
export type SelfMcpReceiptOutcome = z.infer<typeof selfMcpReceiptOutcomeSchema>

export const selfMcpReceiptSchema = z.object({
    id: z.string().min(1).max(128),
    proposalId: z.string().min(1).max(128),
    decisionId: z.string().min(1).max(128),
    outcome: selfMcpReceiptOutcomeSchema,
    configRevision: z.number().int().nonnegative(),
    detail: z.string().max(4_000).optional(),
    createdAt: z.string().min(1),
}).strict()
export type SelfMcpReceipt = z.infer<typeof selfMcpReceiptSchema>

// --- Decision result (server -> client) ------------------------------------

export const selfMcpDecisionResultSchema = z.object({
    outcome: z.enum(['applied', 'applied_pending_credentials', 'applied_unverified', 'rejected', 'cancelled', 'failed', 'converged', 'in_flight']),
    proposalId: z.string().min(1).max(128),
    proposalRevision: z.number().int().nonnegative(),
    message: z.string(),
    receipt: selfMcpReceiptSchema.optional(),
    /** Visible requirements that prevented the decision from taking effect (never silently enabled). */
    requirements: z.array(z.string()).default([]),
}).strict()
export type SelfMcpDecisionResult = z.infer<typeof selfMcpDecisionResultSchema>

// --- Review snapshot (what the review editor renders) -----------------------

export const selfMcpReviewSnapshotSchema = z.object({
    proposal: selfMcpProposalSchema,
    /** Current configuration revision for the CAS round-trip back into the editor. */
    configRevision: z.number().int().nonnegative(),
    connectivity: selfMcpConnectivitySchema,
    requirements: z.array(z.string()).default([]),
    /** Replacement conflict: the proposed name already exists and/or is service-managed. */
    conflict: z.object({
        existing: z.boolean(),
        managed: z.boolean(),
        replaces: z.string().optional(),
    }).optional(),
    /** The exact proposed server (fingerprint) is already present in the trusted configuration. */
    alreadyConfigured: z.boolean().default(false),
}).strict()
export type SelfMcpReviewSnapshot = z.infer<typeof selfMcpReviewSnapshotSchema>

// --- Engine -> UI propose bridge -------------------------------------------

export const selfMcpProposeRequestSchema = z.object({
    action: z.literal('propose'),
    identity: selfMcpRunIdentitySchema,
    /** Fingerprint computed in the engine; the UI recomputes it and refuses on mismatch. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    input: z.unknown(),
}).strict()
export type SelfMcpProposeRequest = z.infer<typeof selfMcpProposeRequestSchema>

export const selfMcpProposeResultSchema = z.object({
    outcome: z.enum(['proposed', 'reconciled', 'conflict', 'refused']),
    message: z.string(),
    proposal: selfMcpProposalSchema.optional(),
}).strict()
export type SelfMcpProposeResult = z.infer<typeof selfMcpProposeResultSchema>

// --- Management request envelope (client -> server) -------------------------

export const selfMcpRequestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('review'), proposalId: z.string().min(1).max(128) }).strict(),
    z.object({ action: z.literal('decide'), decision: selfMcpDecisionRequestSchema }).strict(),
    z.object({ action: z.literal('dismiss'), proposalId: z.string().min(1).max(128), expectedProposalRevision: z.number().int().nonnegative() }).strict(),
])
export type SelfMcpRequest = z.infer<typeof selfMcpRequestSchema>

// --- Validation helpers -----------------------------------------------------

export function selfMcpReservedNameIssue(name: string): string | null {
    if (name === SELF_MCP_RESERVED_NAME) {
        return `"${SELF_MCP_RESERVED_NAME}" is reserved for the engine's own tools. Register this server under another name, for example "${SELF_MCP_RESERVED_NAME}_admin".`
    }
    return null
}

export function selfMcpNameIssue(name: string): string | null {
    if (!MCP_SERVER_NAME_RE.test(name)) {
        return `MCP server name "${name}" is invalid: use 1-64 characters (letters, digits, underscores, hyphens). Tools are exposed as "<server>_<tool>" and providers reject other characters.`
    }
    return null
}

function hasPlaceholder(value: string): boolean {
    return value.includes('${')
}

/**
 * Strict nonsecret validation of a proposed server. Returns a human-readable
 * issue, or null when the input is safe to persist as a proposal. Enforces:
 *  - the original safe server-name rules and the reserved bridge name;
 *  - a single consistent destination (command for stdio, url for http/sse);
 *  - bounded URLs without credentials, query or fragment;
 *  - env values that are pure `${NAME}` references and header values that are
 *    fixed templates embedding exactly one `${NAME}` reference — inline
 *    credentials and raw environment secrets are structurally impossible;
 *  - no unrecognized fields (the strict schema already rejects extras).
 */
export function selfMcpInputIssue(value: unknown): string | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'Provide an MCP server description as an object.'
    const input = value as Record<string, unknown>
    const name = typeof input.name === 'string' ? input.name : ''
    const reserved = selfMcpReservedNameIssue(name)
    if (reserved) return reserved
    const invalid = selfMcpNameIssue(name)
    if (invalid) return invalid

    const transport = input.transport
    if (transport !== undefined && !selfMcpTransportSchema.safeParse(transport).success) {
        return 'Transport must be "stdio", "sse" or "http".'
    }
    const kind = transport as SelfMcpTransport | undefined
    const command = typeof input.command === 'string' && input.command ? input.command.trim() : undefined
    const url = typeof input.url === 'string' && input.url ? input.url.trim() : undefined
    if (command && url) return 'Provide one destination: a local command or a remote URL.'
    if (kind === 'stdio' && !command) return `MCP server "${name}" needs a command for stdio.`
    if ((kind === 'http' || kind === 'sse') && !url) return `MCP server "${name}" needs a url for ${kind}.`
    if (!kind && !command && !url) return `MCP server "${name}" needs a command (stdio) or a url (sse/http).`

    if (url !== undefined) {
        let parsed: URL
        try {
            parsed = new URL(url)
        } catch {
            return `MCP server "${name}" has an invalid url: ${url}.`
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Use an http(s) endpoint without credentials, query or fragment.'
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
            return 'Use an http(s) endpoint without credentials, query or fragment.'
        }
        if (hasPlaceholder(url)) return `MCP server "${name}" must not embed variable references in its url; put them in headers instead.`
    }

    if (input.command !== undefined && typeof input.command !== 'string') return 'Command must be a string.'
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string'))) {
        return 'Arguments must be a list of strings.'
    }

    const env = input.env
    if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) return 'Environment must be an object of NAME=value entries.'
    if (env !== undefined) {
        for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
            if (!ENV_KEY_RE.test(key)) return `Environment variable "${key}" is not a valid variable name.`
            if (typeof value !== 'string' || !PURE_PLACEHOLDER_RE.test(value)) {
                return `Environment variable "${key}" must be a ${'${NAME}'} reference, never an inline secret.`
            }
        }
    }

    const headers = input.headers
    if (headers !== undefined && (headers === null || typeof headers !== 'object' || Array.isArray(headers))) return 'Headers must be an object of Header=value entries.'
    if (headers !== undefined) {
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
            if (!HEADER_KEY_RE.test(key)) return `Header "${key}" is not a valid HTTP header name.`
            if (typeof value !== 'string' || !HEADER_TEMPLATE_RE.test(value)) {
                return `Header "${key}" must be a fixed template with one ${'${NAME}'} reference, never an inline secret.`
            }
        }
    }

    return null
}

/** Parses and validates a raw candidate into a typed nonsecret input, or null when invalid. */
export function selfMcpProposalInput(value: unknown): SelfMcpServerInput | null {
    if (selfMcpInputIssue(value) !== null) return null
    const parsed = selfMcpServerInputSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}

/**
 * Mirrors the hosted `resolveTransport`: explicit transport wins, then stdio for
 * a command, then url (an `/sse`-suffixed url is sse), defaulting to stdio.
 */
export function selfMcpResolvedTransport(input: { transport?: SelfMcpTransport; command?: string; url?: string }): SelfMcpTransport {
    if (input.transport) return input.transport
    if (input.command) return 'stdio'
    if (input.url) return input.url.replace(/\/+$/, '').endsWith('/sse') ? 'sse' : 'http'
    return 'stdio'
}

/**
 * Canonical, deterministic serialization of the nonsecret candidate: fixed key
 * order with env/headers sorted by key. The engine and the UI node modules hash
 * this exact string with sha256, so the fingerprint is identical on both sides.
 */
export function selfMcpCanonicalInput(input: SelfMcpServerInput): string {
    const env = Object.fromEntries(Object.entries(input.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    const headers = Object.fromEntries(Object.entries(input.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    return JSON.stringify({
        name: input.name,
        transport: input.transport ?? null,
        command: input.command ?? null,
        args: input.args,
        url: input.url ?? null,
        env,
        headers,
    })
}
