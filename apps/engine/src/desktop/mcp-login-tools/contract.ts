import { z } from 'zod'

export const MCP_LOGIN_BRIDGE_PATH = '/api/desktop/internal/mcp-login'
export const MCP_LOGIN_TOOL_NAMES = ['request_mcp_sign_in', 'mcp_login', 'mcp_login_complete', 'mcp_status'] as const
export type McpLoginToolName = typeof MCP_LOGIN_TOOL_NAMES[number]
const id = z.string().min(1).max(256)
export const loginNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
export const loginIdentitySchema = z.object({ engineAgentId: id, sessionId: id, runId: id }).strict()
const base = { identity: loginIdentitySchema, toolCallId: id }
export const loginRequestSchema = z.discriminatedUnion('action', [
    z.object({ ...base, action: z.literal('status') }).strict(),
    z.object({ ...base, action: z.literal('start'), name: loginNameSchema }).strict(),
    z.object({ ...base, action: z.literal('complete'), name: loginNameSchema }).strict(),
])
export type LoginIdentity = z.infer<typeof loginIdentitySchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
export const inventoryRowSchema = z.object({
    name: loginNameSchema, revision: id, transport: z.enum(['http', 'sse', 'stdio']),
    status: z.enum(['connected', 'failed', 'unavailable']),
    tools: z.array(z.string().regex(/^[\w.-]{1,128}$/)).max(256),
    reason: z.enum(['probe_failed', 'transport_unavailable', 'permission_required']).optional(),
}).strict().superRefine((row, ctx) => {
    if (row.status !== 'connected' && row.tools.length) ctx.addIssue({ code: 'custom', message: 'Unverified tools cannot be advertised' })
})
export const deviceViewSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('waiting'), verificationUri: z.string().url().max(4096), expiresIn: z.number().int().min(1).max(1800) }).strict(),
    z.object({ state: z.literal('connected'), tools: z.array(z.string().regex(/^[\w.-]{1,128}$/)).max(256) }).strict(),
    z.object({ state: z.enum(['approval_required', 'unsupported', 'no_pending', 'pending', 'unknown', 'failed']) }).strict(),
])
export type DeviceView = z.infer<typeof deviceViewSchema>
export const loginResponseSchema = z.object({
    identity: loginIdentitySchema, toolCallId: id,
    result: z.discriminatedUnion('action', [
        z.object({ action: z.literal('status'), servers: z.array(inventoryRowSchema).max(16) }).strict(),
        z.object({ action: z.enum(['start', 'complete']), name: loginNameSchema, view: deviceViewSchema }).strict(),
    ]),
}).strict()
export type LoginResponse = z.infer<typeof loginResponseSchema>

export function safeVerificationUri(value: string): string {
    if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid verification destination')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal)$/.test(url.hostname) || url.hostname.endsWith('.')) throw new Error('Invalid verification destination')
    return url.href
}
