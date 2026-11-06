import { z } from 'zod'

const id = z.string().min(1).max(256)
const safeUrl = z.string().url().max(8192).refine(value => {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.hash
})
const authorizationUrl = z.string().url().max(8192).refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
})

export const desktopMcpSignInServerSchema = z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    revision: id,
    url: safeUrl,
    displayName: z.string().min(1).max(200),
    host: z.string().max(256).optional(),
    icon: z.string().max(2048).nullable().optional(),
}).strict()
export type DesktopMcpSignInServer = z.infer<typeof desktopMcpSignInServerSchema>

export const desktopMcpSignInSourceSchema = z.object({
    agentId: id,
    sessionId: id,
    runId: id,
    sourceMessageId: id,
    toolCallId: id,
    fingerprint: z.string().min(1).max(32_768),
    server: desktopMcpSignInServerSchema,
}).strict()
export type DesktopMcpSignInSource = z.infer<typeof desktopMcpSignInSourceSchema>

export const desktopMcpSignInRequestInputSchema = z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    reason: z.string().max(300).optional(),
}).strict()
export type DesktopMcpSignInRequestInput = z.infer<typeof desktopMcpSignInRequestInputSchema>

export const desktopMcpSignInReceiptSchema = z.object({
    attemptId: id,
    outcome: z.enum(['connected', 'declined']),
    summary: z.string().max(2000),
    continuationRequestId: id,
    accepted: z.boolean(),
    createdAt: z.string().max(64),
}).strict()
export type DesktopMcpSignInReceipt = z.infer<typeof desktopMcpSignInReceiptSchema>

export const desktopMcpSignInViewSchema = z.object({
    requestId: id,
    revision: id,
    source: desktopMcpSignInSourceSchema,
    reason: z.string().max(300).optional(),
    status: z.enum(['pending', 'connecting', 'connected', 'declined', 'error']),
    activeAttemptId: id.optional(),
    error: z.string().max(400).optional(),
    receipt: desktopMcpSignInReceiptSchema.optional(),
    createdAt: z.string().max(64),
    updatedAt: z.string().max(64),
}).strict()
export type DesktopMcpSignInView = z.infer<typeof desktopMcpSignInViewSchema>

export const desktopMcpSignInOAuthViewSchema = z.object({
    state: z.enum(['idle', 'waiting', 'connected', 'error', 'unsupported']),
    message: z.string().max(400).optional(),
    authorizationUrl: authorizationUrl.optional(),
}).strict()
export type DesktopMcpSignInOAuthView = z.infer<typeof desktopMcpSignInOAuthViewSchema>

export const desktopMcpSignInResponseSchema = z.object({
    request: desktopMcpSignInViewSchema.nullable(),
    oauth: desktopMcpSignInOAuthViewSchema.optional(),
}).strict()
export type DesktopMcpSignInResponse = z.infer<typeof desktopMcpSignInResponseSchema>

export const desktopMcpSignInDecisionSchema = z.object({
    operation: z.enum(['connect', 'decline', 'cancel']),
    requestId: id,
    attemptId: id,
    expectedRevision: id,
    source: desktopMcpSignInSourceSchema,
}).strict()
export type DesktopMcpSignInDecision = z.infer<typeof desktopMcpSignInDecisionSchema>

export function serializeDesktopMcpSignInResult(name: string, outcome: DesktopMcpSignInReceipt['outcome']): string {
    return outcome === 'connected' ? `MCP sign-in result:\n- ${name}: connected\n\nIts tools are available now. Please continue.` : '[User skipped signing in to the MCP server]'
}

export const desktopMcpSignInGuardSchema = desktopMcpSignInSourceSchema.omit({ agentId: true, sessionId: true })
export type DesktopMcpSignInGuard = z.infer<typeof desktopMcpSignInGuardSchema>
export const desktopMcpSignInSourceResponseSchema = z.object({
    agentId: id, sessionId: id,
    request: z.object({ input: desktopMcpSignInRequestInputSchema, guard: desktopMcpSignInGuardSchema, status: z.enum(['running', 'done', 'error', 'cancelled']) }).strict().nullable(),
}).strict()
export const desktopMcpSignInBridgeSchema = z.object({
    identity: z.object({ engineAgentId: id, sessionId: id, runId: id }).strict(),
    input: desktopMcpSignInRequestInputSchema,
}).strict()
export function parseDesktopMcpSignInInput(raw: unknown): DesktopMcpSignInRequestInput | null {
    try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!value || typeof value !== 'object') return null
        const parsed = desktopMcpSignInRequestInputSchema.safeParse({ ...value, ...(value.reason == null ? { reason: undefined } : {}) })
        return parsed.success ? parsed.data : null
    } catch { return null }
}
export function desktopMcpSignInAcknowledgement(raw: unknown, depth = 0): DesktopMcpSignInServer | null {
    if (depth > 5) return null
    try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!value || typeof value !== 'object' || value.isError === true || value.type === 'error-text' || value.type === 'error-json') return null
        if (value.status === 'delivered') { const server = desktopMcpSignInServerSchema.safeParse(value.server); return server.success ? server.data : null }
        if (value.value !== undefined) return desktopMcpSignInAcknowledgement(value.value, depth + 1)
        if (value.structuredContent !== undefined) return desktopMcpSignInAcknowledgement(value.structuredContent, depth + 1)
        if (Array.isArray(value.content)) for (const part of value.content) { if (part?.type === 'text') { const found = desktopMcpSignInAcknowledgement(part.text, depth + 1); if (found) return found } }
    } catch { /* A malformed output is not an acknowledgement. */ }
    return null
}
