import { z } from 'zod'

export const DESKTOP_CLAUDE_PLAN_AUTH_LIFETIME_MS = 15 * 60_000
export const DESKTOP_CLAUDE_PLAN_CLI_TIMEOUT_MS = 30_000
export const DESKTOP_CLAUDE_PLAN_MAX_OUTPUT_CHARS = 64_000
export const DESKTOP_CLAUDE_PLAN_MAX_HISTORY_EVENTS = 1_000

const publicId = z.string().trim().min(1).max(256)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.string().regex(/^[0-9]{1,18}$/)
const isoTime = z.string().datetime()

export const desktopClaudePlanOwnerSchema = z.strictObject({ agentId: publicId })
export type DesktopClaudePlanOwner = z.infer<typeof desktopClaudePlanOwnerSchema>

export const desktopClaudePlanAttemptSchema = z.strictObject({
    attemptId: hex64,
    agentId: publicId,
    revision,
    phase: z.enum(['waiting', 'checking', 'connected', 'cancelled', 'expired', 'error', 'disconnected']),
    authorizeUrl: z.string().url().optional(),
    verifier: z.string().min(1).max(256).optional(),
    state: z.string().min(1).max(256).optional(),
    credentialRevision: revision.optional(),
    message: z.string().max(500).optional(),
    createdAt: isoTime,
    updatedAt: isoTime,
    expiresAt: isoTime.optional(),
})
export type DesktopClaudePlanAttempt = z.infer<typeof desktopClaudePlanAttemptSchema>

export const desktopClaudePlanCompleteInputSchema = z.strictObject({
    attemptId: hex64,
    requestId: z.string().uuid(),
    rawCode: z.string().trim().min(1).max(8_192),
    verifier: z.string().min(1).max(256),
    state: z.string().min(1).max(256),
})
export type DesktopClaudePlanCompleteInput = z.infer<typeof desktopClaudePlanCompleteInputSchema>
export const desktopClaudePlanAttemptActionSchema = z.strictObject({
    operation: z.enum(['cancel', 'disconnect']),
    requestId: z.string().uuid(),
    attemptId: hex64,
    expectedRevision: revision,
})
export type DesktopClaudePlanAttemptAction = z.infer<typeof desktopClaudePlanAttemptActionSchema>

export type DesktopClaudePlanCredential = { accessToken: string; refreshToken?: string; expiresAt?: number }
export type DesktopClaudePlanCredentialCustody = {
    load(agentId: string): Promise<DesktopClaudePlanCredential | null>
    save(agentId: string, credential: DesktopClaudePlanCredential): Promise<{ revision: string }>
    clear(agentId: string): Promise<void>
}
export type DesktopClaudePlanOAuth = {
    start(): Promise<{ authorizeUrl: string; verifier: string; state: string }>
    exchange(input: { rawCode: string; verifier: string; state: string; signal: AbortSignal }): Promise<DesktopClaudePlanCredential>
}
export type DesktopClaudePlanAttemptStore = {
    begin(attempt: DesktopClaudePlanAttempt): Promise<'execute' | DesktopClaudePlanAttempt>
    complete(attempt: DesktopClaudePlanAttempt): Promise<void>
    read(attemptId: string): Promise<DesktopClaudePlanAttempt | null>
    active(agentId: string): Promise<DesktopClaudePlanAttempt | null>
    connected(agentId: string): Promise<DesktopClaudePlanAttempt | null>
}

export const desktopClaudePlanModelSchema = z.enum(['claude-sonnet-4-6', 'claude-opus-5-5'])
export type DesktopClaudePlanModel = z.infer<typeof desktopClaudePlanModelSchema>
export const desktopClaudePlanThinkingSchema = z.enum(['adaptive', 'disabled'])
export type DesktopClaudePlanThinking = z.infer<typeof desktopClaudePlanThinkingSchema>
export const desktopClaudePlanChatInputSchema = z.strictObject({
    message: z.string().trim().min(1).max(100_000),
    model: desktopClaudePlanModelSchema,
    thinking: desktopClaudePlanThinkingSchema.default('adaptive'),
    system: z.string().max(100_000).optional(),
})
export type DesktopClaudePlanChatInput = z.infer<typeof desktopClaudePlanChatInputSchema>

export const desktopClaudePlanChatIdentitySchema = z.strictObject({
    agentId: publicId,
    sessionId: publicId,
    runId: publicId,
    toolCallId: publicId,
    credentialRevision: revision,
})
export type DesktopClaudePlanChatIdentity = z.infer<typeof desktopClaudePlanChatIdentitySchema>

export const desktopClaudePlanStreamEventSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text-delta'), text: z.string().max(100_000) }),
    z.strictObject({ type: z.literal('reasoning-delta'), text: z.string().max(100_000) }),
    z.strictObject({ type: z.literal('tool-call'), toolCallId: publicId, toolName: publicId, input: z.unknown().optional() }),
    z.strictObject({ type: z.literal('tool-result'), toolCallId: publicId, output: z.unknown().optional(), isError: z.boolean().optional() }),
    z.strictObject({ type: z.literal('source'), url: z.string().url(), title: z.string().max(512).optional() }),
    z.strictObject({ type: z.literal('usage'), usedTokens: z.number().int().nonnegative(), maxTokens: z.number().int().positive().optional() }),
    z.strictObject({ type: z.literal('finish'), finishReason: z.enum(['stop', 'length', 'tool-calls', 'error', 'cancelled']) }),
    z.strictObject({ type: z.literal('error'), message: z.string().max(500) }),
])
export type DesktopClaudePlanStreamEvent = z.infer<typeof desktopClaudePlanStreamEventSchema>

export const desktopClaudePlanChatResultSchema = z.strictObject({
    operationId: hex64,
    agentId: publicId,
    sessionId: publicId,
    runId: publicId,
    toolCallId: publicId,
    credentialRevision: revision,
    status: z.enum(['completed', 'error', 'cancelled', 'uncertain']),
    text: z.string().max(1_000_000),
    model: desktopClaudePlanModelSchema,
    events: z.array(desktopClaudePlanStreamEventSchema).max(DESKTOP_CLAUDE_PLAN_MAX_HISTORY_EVENTS),
    message: z.string().max(500).optional(),
    createdAt: isoTime,
    updatedAt: isoTime,
})
export type DesktopClaudePlanChatResult = z.infer<typeof desktopClaudePlanChatResultSchema>

export type DesktopClaudePlanRunner = {
    dispatch(identity: DesktopClaudePlanChatIdentity, input: DesktopClaudePlanChatInput, signal: AbortSignal): AsyncIterable<DesktopClaudePlanStreamEvent>
    stop(identity: DesktopClaudePlanChatIdentity, signal: AbortSignal): Promise<void>
}
export type DesktopClaudePlanChatStore = {
    begin(identity: DesktopClaudePlanChatIdentity, operationId: string): Promise<'execute' | DesktopClaudePlanChatResult>
    complete(result: DesktopClaudePlanChatResult): Promise<void>
    read(operationId: string): Promise<DesktopClaudePlanChatResult | null>
}
export type DesktopClaudePlanAuthority = (identity: DesktopClaudePlanChatIdentity, signal: AbortSignal) => Promise<void>

export const desktopClaudePlanAvailabilitySchema = z.strictObject({
    state: z.enum(['ready', 'unconfigured', 'unavailable']),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    cliVersion: z.string().max(100).optional(),
})
export type DesktopClaudePlanAvailability = z.infer<typeof desktopClaudePlanAvailabilitySchema>
export type DesktopClaudePlanProbe = (signal: AbortSignal) => Promise<DesktopClaudePlanAvailability>

export function desktopClaudePlanOperationId(identity: DesktopClaudePlanChatIdentity, input: DesktopClaudePlanChatInput): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify([identity, input]))
    return globalThis.crypto.subtle.digest('SHA-256', bytes).then(hash => Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join(''))
}
