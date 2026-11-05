import { z } from 'zod'

export const DESKTOP_SECRET_REQUEST_VERSION = 1
export const DESKTOP_SECRET_VALUE_MAX_BYTES = 16_384
export const DESKTOP_SECRET_TOTAL_MAX_BYTES = 65_536
export const DESKTOP_SECRET_RESERVED_KEYS = new Set([
    'ENGINE_API_KEY', 'ENCRYPTION_KEY', 'DESKTOP_ENCRYPTION_KEY', 'SESSION_TOKEN', 'DATABASE_URL',
    'PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_ENV',
])
export const DESKTOP_SECRET_RESERVED_PREFIXES = ['RERUN_', 'NEXT_']

const id = z.string().min(1).max(128)
const publicText = z.string().min(1).max(256)

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
    sourceMessageId: id,
    toolCallId: id,
    fingerprint: publicText,
}).strict()
export type DesktopSecretRequestSource = z.infer<typeof desktopSecretRequestSourceSchema>

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
