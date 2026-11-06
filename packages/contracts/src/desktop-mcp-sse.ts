import { z } from 'zod'
import { mcpServerNameSchema, mcpServerSchema } from './agent.js'

export const DESKTOP_MCP_SSE_LIMITS = {
    connectMs: 20_000, requestMs: 120_000, postMs: 20_000, closeMs: 3_000,
    idleMs: 60_000, lifetimeMs: 10 * 60_000, eventBytes: 1_048_576,
    bufferBytes: 1_100_000, streamBytes: 16 * 1_048_576, events: 4096,
    requestBytes: 65_536, resultBytes: 1_048_576, catalogBytes: 1_048_576,
    tools: 256, pages: 8, cursorChars: 4096, schemaDepth: 32, schemaNodes: 10_000,
    inflight: 16, requestIds: 4096, endpointChars: 4096, sessionChars: 256, connections: 32,
} as const
const id = z.string().min(1).max(200).regex(/^[^\p{Cc}]+$/u)
export const desktopMcpSseRefSchema = z.object({
    agentId: id, serverId: id, name: mcpServerNameSchema, expectedRevision: id,
}).strict()
export type DesktopMcpSseRef = z.infer<typeof desktopMcpSseRefSchema>
export const desktopMcpSseRequestSchema = desktopMcpSseRefSchema.extend({
    requestId: z.string().uuid(), operation: z.enum(['status', 'connect', 'probe', 'disconnect']),
}).strict()
export type DesktopMcpSseRequest = z.infer<typeof desktopMcpSseRequestSchema>
export const desktopMcpSseCallSchema = desktopMcpSseRefSchema.extend({
    requestId: z.string().uuid(), sessionId: id, runId: id, toolCallId: id,
    tool: z.string().regex(/^[\w.-]{1,128}$/), arguments: z.record(z.string(), z.unknown()),
}).strict()
export type DesktopMcpSseCall = z.infer<typeof desktopMcpSseCallSchema>
export const desktopMcpSseToolSchema = z.object({
    name: z.string().regex(/^[\w.-]{1,128}$/), description: z.string().max(8000).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
}).strict()
export type DesktopMcpSseTool = z.infer<typeof desktopMcpSseToolSchema>
export const desktopMcpSseFailureSchema = z.enum(['auth-needed', 'unsupported', 'unavailable', 'invalid-data', 'changed', 'timeout', 'cancelled', 'close-unconfirmed'])
export type DesktopMcpSseFailure = z.infer<typeof desktopMcpSseFailureSchema>
export const desktopMcpSseSnapshotSchema = desktopMcpSseRefSchema.extend({
    transport: z.literal('sse'), endpointDisplay: z.string().max(512).refine(value => {
        if (!value) return true
        try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password } catch { return false }
    }, 'Only the sanitized HTTPS origin may be displayed.'),
    state: z.enum(['unchecked', 'connecting', 'connected', 'disconnected', 'needs_auth', 'unsupported', 'error', 'closing']),
    tools: z.array(desktopMcpSseToolSchema).max(DESKTOP_MCP_SSE_LIMITS.tools),
    observation: z.enum(['live', 'probe', 'saved']).optional(),
    failure: desktopMcpSseFailureSchema.optional(), message: z.string().max(240).optional(),
}).strict()
export type DesktopMcpSseSnapshot = z.infer<typeof desktopMcpSseSnapshotSchema>
export const desktopMcpSseOutcomeSchema = z.object({
    requestId: z.string().uuid(), status: z.enum(['completed', 'uncertain', 'refused']),
    result: z.record(z.string(), z.unknown()).optional(),
    failure: desktopMcpSseFailureSchema.optional(), message: z.string().max(240).optional(),
}).strict().superRefine((value, ctx) => {
    if ((value.status === 'completed') !== (value.result !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only acknowledged calls carry results.' })
})
export type DesktopMcpSseOutcome = z.infer<typeof desktopMcpSseOutcomeSchema>

// Transport-specific settings delta; the existing MCP configuration remains authoritative.
export const desktopMcpSseConfigurationSchema = mcpServerSchema.pick({ name: true, transport: true, url: true })
    .extend({ name: mcpServerNameSchema, transport: z.literal('sse'), url: z.string().min(1).max(4096) }).strict()
export type DesktopMcpSseConfiguration = z.infer<typeof desktopMcpSseConfigurationSchema>
export type DesktopMcpSseSave = {
    agentId: string; requestId: string; serverId: string | null; expectedRevision: string | null
    configuration: DesktopMcpSseConfiguration
}
export type DesktopMcpSseMutationResult =
    | { requestId: string; status: 'saved'; reference?: DesktopMcpSseRef }
    | { requestId: string; status: 'unknown' | 'refused' | 'not-saved'; message?: string }
