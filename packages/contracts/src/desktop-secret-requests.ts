import { z } from 'zod'
import { stripBridgePrefix } from './chat-tool-name.js'

export const DESKTOP_SECRET_REQUEST_VERSION = 1
export const DESKTOP_SECRET_VALUE_MAX_BYTES = 16_384
export const DESKTOP_SECRET_TOTAL_MAX_BYTES = 65_536
export const DESKTOP_SECRET_RESERVED_KEYS = new Set([
    'ENGINE_API_KEY', 'ENCRYPTION_KEY', 'DESKTOP_ENCRYPTION_KEY', 'SESSION_TOKEN', 'DATABASE_URL',
    'PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_ENV',
])
export const DESKTOP_SECRET_RESERVED_PREFIXES = ['RERUN_', 'NEXT_']

const id = z.string().min(1).max(128)
const publicText = z.string().min(1).max(32_768)

export const desktopSecretRequestFieldSchema = z.object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64),
    label: z.string().min(1).max(100),
    help: z.string().max(300).optional(),
    docsUrl: z.string().url().max(2048).refine(value => new URL(value).protocol === 'https:').optional(),
}).strict()
export type DesktopSecretRequestField = z.infer<typeof desktopSecretRequestFieldSchema>

export const desktopSecretRequestInputSchema = z.object({
    fields: z.array(desktopSecretRequestFieldSchema).min(1).max(8),
    reason: z.string().max(300).optional(),
}).strict().superRefine((input, context) => {
    const keys = new Set<string>()
    for (const field of input.fields) {
        if (DESKTOP_SECRET_RESERVED_KEYS.has(field.key) || DESKTOP_SECRET_RESERVED_PREFIXES.some(prefix => field.key.startsWith(prefix))) {
            context.addIssue({ code: 'custom', message: `${field.key} is reserved for desktop runtime configuration.` })
        }
        if (keys.has(field.key)) context.addIssue({ code: 'custom', message: `${field.key} was requested more than once.` })
        keys.add(field.key)
    }
})
export type DesktopSecretRequestInput = z.infer<typeof desktopSecretRequestInputSchema>

export const desktopSecretRequestSourceSchema = z.object({
    agentId: id,
    sessionId: id,
    runId: id,
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    fingerprint: publicText,
}).strict()
export type DesktopSecretRequestSource = z.infer<typeof desktopSecretRequestSourceSchema>
export const desktopSecretRequestGuardSchema = desktopSecretRequestSourceSchema.omit({ agentId: true, sessionId: true })
export type DesktopSecretRequestGuard = z.infer<typeof desktopSecretRequestGuardSchema>

export type DesktopSecretRequestRow = { id: string; role: string; contentJson: string; toolCallsJson?: string | null; createdAt?: string | null }
export type DesktopSecretRequestCall = DesktopSecretRequestInput & { sourceMessageId: string; toolCallId: string; fingerprint: string; requestedAt?: string | null }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function json(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch { return value } }

export function parseDesktopSecretToolInput(raw: unknown): DesktopSecretRequestInput | null {
    const input = record(json(raw))
    const batch = json(input.secrets)
    if (!Array.isArray(batch)) return null
    const fields = batch.map(raw => {
        const { help, docsUrl, ...field } = record(raw)
        return { ...field, ...(help != null ? { help } : {}), ...(docsUrl != null ? { docsUrl } : {}) }
    })
    const parsed = desktopSecretRequestInputSchema.safeParse({ fields, ...(input.reason != null ? { reason: input.reason } : {}) })
    return parsed.success ? parsed.data : null
}

function delivered(raw: unknown, depth = 0): boolean {
    if (depth > 5) return false
    const value = record(json(raw))
    if (value.isError === true || value.type === 'error-text' || value.type === 'error-json') return false
    if (value.status === 'delivered') return true
    if ((value.type === 'json' || value.type === 'text') && 'value' in value) return delivered(value.value, depth + 1)
    if (value.structuredContent != null && delivered(value.structuredContent, depth + 1)) return true
    return Array.isArray(value.content) && value.content.some(part => record(part).type === 'text' && delivered(record(part).text, depth + 1))
}

/** Only an acknowledged last-turn request can become a form. No field values are accepted. */
export function findDesktopSecretRequest(rows: readonly DesktopSecretRequestRow[]): DesktopSecretRequestCall | null {
    let candidate: DesktopSecretRequestCall | null = null
    let acknowledged = false
    for (const row of rows) {
        if (row.role === 'user') { candidate = null; acknowledged = false; continue }
        const content = json(row.contentJson), legacy = json(row.toolCallsJson)
        for (const raw of [...(Array.isArray(content) ? content : [content]), ...(Array.isArray(legacy) ? legacy : [])]) {
            const part = record(raw), callId = part.toolCallId ?? part.id
            if (part.type === 'tool-result' || (row.role === 'tool' && (part.output !== undefined || part.result !== undefined))) {
                if (candidate && callId === candidate.toolCallId) acknowledged = part.isError !== true && delivered(part.output ?? part.result)
                continue
            }
            if (row.role !== 'assistant' || (part.type !== 'tool-call' && !part.toolName && !part.name && !record(part.function).name)) continue
            const rawName = part.toolName ?? part.name ?? record(part.function).name
            const name = typeof rawName === 'string' ? stripBridgePrefix(rawName) : ''
            if (name === 'skill_propose') continue
            candidate = null; acknowledged = false
            if (name !== 'request_secret' || typeof callId !== 'string' || !callId || callId.length > 256 || !row.id || row.id.length > 256) continue
            const input = parseDesktopSecretToolInput(part.input ?? part.args ?? part.arguments ?? record(part.function).arguments)
            if (input) candidate = { ...input, sourceMessageId: row.id, toolCallId: callId, fingerprint: JSON.stringify(input), requestedAt: row.createdAt }
        }
    }
    return acknowledged ? candidate : null
}

export const desktopSecretSourceResponseSchema = z.object({
    agentId: id, sessionId: id,
    request: z.object({ input: desktopSecretRequestInputSchema, guard: desktopSecretRequestGuardSchema, status: z.enum(['running', 'done', 'error', 'cancelled']), requestedAt: z.string().nullable().optional() }).strict().nullable(),
}).strict()

export function sameDesktopSecretRequestSource(left: DesktopSecretRequestSource, right: DesktopSecretRequestSource): boolean {
    return left.agentId === right.agentId && left.sessionId === right.sessionId && left.runId === right.runId
        && left.sourceMessageId === right.sourceMessageId && left.toolCallId === right.toolCallId && left.fingerprint === right.fingerprint
}

export const desktopSecretRequestViewFieldSchema = desktopSecretRequestFieldSchema.extend({ existing: z.boolean() }).strict()
export type DesktopSecretRequestViewField = z.infer<typeof desktopSecretRequestViewFieldSchema>

export const desktopSecretRequestReceiptSchema = z.object({
    attemptId: id,
    decision: z.enum(['save', 'skip', 'dismiss']),
    providedKeys: z.array(z.string().max(64)).max(8),
    skippedKeys: z.array(z.string().max(64)).max(8),
    summary: z.string().max(10_000),
    continuationRequestId: id,
    accepted: z.boolean(),
    createdAt: z.string().max(64),
}).strict()
export type DesktopSecretRequestReceipt = z.infer<typeof desktopSecretRequestReceiptSchema>

export const desktopSecretRequestAttemptViewSchema = z.object({
    attemptId: id,
    operation: z.enum(['save', 'skip', 'dismiss']),
    state: z.enum(['staged', 'sealed']),
}).strict()

export const desktopSecretRequestViewSchema = z.object({
    requestId: id,
    revision: id,
    source: desktopSecretRequestSourceSchema,
    reason: z.string().max(300).optional(),
    fields: z.array(desktopSecretRequestViewFieldSchema).min(1).max(8),
    status: z.enum(['pending', 'sealed', 'accepted']),
    pendingAttempt: desktopSecretRequestAttemptViewSchema.optional(),
    receipt: desktopSecretRequestReceiptSchema.optional(),
    createdAt: z.string().max(64),
    updatedAt: z.string().max(64),
}).strict()
export type DesktopSecretRequestView = z.infer<typeof desktopSecretRequestViewSchema>
export const desktopSecretRequestResponseSchema = z.object({ request: desktopSecretRequestViewSchema.nullable() }).strict()

export const desktopSecretRequestDecisionSchema = z.object({
    operation: z.enum(['save', 'skip', 'dismiss']),
    requestId: id,
    attemptId: id,
    expectedRevision: id,
    source: desktopSecretRequestSourceSchema,
    values: z.record(z.string(), z.string()).optional(),
}).strict()
export type DesktopSecretRequestDecision = z.infer<typeof desktopSecretRequestDecisionSchema>

export const desktopSecretRequestRecoverySchema = desktopSecretRequestDecisionSchema.omit({ operation: true, values: true }).extend({
    operation: z.literal('recover'),
}).strict()
export type DesktopSecretRequestRecovery = z.infer<typeof desktopSecretRequestRecoverySchema>
export const desktopSecretRequestActionSchema = z.union([desktopSecretRequestDecisionSchema, desktopSecretRequestRecoverySchema])
export type DesktopSecretRequestAction = z.infer<typeof desktopSecretRequestActionSchema>

export function serializeDesktopSecretReceiptSummary(fields: readonly DesktopSecretRequestField[], providedKeys: readonly string[], _decision: DesktopSecretRequestReceipt['decision']): string {
    const provided = new Set(providedKeys)
    const lines = fields.map(field => `- ${field.key}: ${provided.has(field.key) ? 'provided (stored encrypted for this coworker)' : 'skipped'}`)
    return `Credential setup result:\n${lines.join('\n')}\n\nA separately authorized operation may use a stored credential. Values are never included in this conversation. Do not ask for the values in chat.`
}

const SUMMARY = /^Credential setup result:\n([\s\S]*)\n\nA separately authorized operation may use a stored credential\. Values are never included in this conversation\. Do not ask for the values in chat\.$/
const SUMMARY_LINE = /^- ([A-Z][A-Z0-9_]*): (provided \(stored encrypted for this coworker\)|skipped)$/

export function parseDesktopSecretReceiptSummary(text: string): { key: string; provided: boolean }[] | null {
    const match = SUMMARY.exec(text.trim())
    if (!match) return null
    const entries = match[1].split('\n').map(line => SUMMARY_LINE.exec(line))
    if (!entries.length || entries.some(entry => !entry)) return null
    return entries.map(entry => ({ key: entry![1], provided: entry![2] !== 'skipped' }))
}
