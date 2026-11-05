import { z } from 'zod'
import { pendingServices, type ServiceSetupOutcome, type ServiceSuggestionItem } from './chat-hitl.js'
import { parseServiceRegistryKey } from './service.js'
import { stripBridgePrefix } from './chat-tool-name.js'

const MAX_SERVICE_CHARS = 32_768
const installationRefSchema = z.strictObject({
    key: z.string().min(1).max(200),
    revision: z.string().uuid(),
})
export const desktopServiceChoiceSchema = z.discriminatedUnion('choice', [
    z.strictObject({ slug: z.string().min(1).max(200), choice: z.enum(['pending', 'skip']) }),
    z.strictObject({ slug: z.string().min(1).max(200), choice: z.literal('use-connection'), installation: installationRefSchema }),
])
export type DesktopServiceChoice = z.infer<typeof desktopServiceChoiceSchema>

// `expectedRevision` is this saved decision. `installation.revision` is the Apps row and is not this value.
export const desktopServiceRequestGuardSchema = z.strictObject({
    sourceMessageId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    fingerprint: z.string().min(1).max(MAX_SERVICE_CHARS),
})
export type DesktopServiceRequestGuard = z.infer<typeof desktopServiceRequestGuardSchema>

const decisionFields = {
    requestId: z.string().uuid(),
    serviceRequestId: z.string().regex(/^[a-f0-9]{64}$/),
    source: desktopServiceRequestGuardSchema,
    expectedRevision: z.string().uuid(),
    currentIndex: z.number().int().min(0).max(19),
    choices: z.array(desktopServiceChoiceSchema).min(1).max(20),
}
export const desktopServiceProgressSchema = z.strictObject({ action: z.literal('progress'), ...decisionFields })
export const desktopServiceFinishSchema = z.strictObject({ action: z.literal('finish'), ...decisionFields })
export const desktopServiceRequestMutationSchema = z.discriminatedUnion('action', [desktopServiceProgressSchema, desktopServiceFinishSchema])
export type DesktopServiceProgress = z.infer<typeof desktopServiceProgressSchema>
export type DesktopServiceFinish = z.infer<typeof desktopServiceFinishSchema>
export type DesktopServiceRequestMutation = z.infer<typeof desktopServiceRequestMutationSchema>

const methodSchema = z.strictObject({
    id: z.string().min(1).max(200),
    supported: z.boolean(),
    reason: z.string().max(300).optional(),
})
function catalogDetails(status: 'available' | 'unsupported-auth') {
    return z.strictObject({
        status: z.literal(status),
        name: z.string().min(1).max(200),
        category: z.string().min(1).max(100),
        summary: z.string().max(4_000),
        icon: z.string().max(2_000).nullable(),
        verified: z.boolean(),
        // Catalog verified/configured metadata is never a connection.
        connected: z.literal(false),
        authentication: z.enum(['supported', 'unsupported']),
        unsupportedReason: z.string().max(300).optional(),
        methods: z.array(methodSchema).max(20),
    })
}
export const desktopServiceRequestCatalogSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('unavailable') }),
    z.strictObject({ status: z.literal('not-found') }),
    catalogDetails('available'),
    catalogDetails('unsupported-auth'),
])
export type DesktopServiceRequestCatalog = z.infer<typeof desktopServiceRequestCatalogSchema>

export const desktopServiceConnectionSchema = z.strictObject({
    key: z.string().min(1).max(200),
    revision: z.string().uuid(),
    slug: z.string().min(1).max(200),
    state: z.enum(['preparing', 'ready', 'error', 'disconnected', 'removing']),
    usable: z.boolean(),
    healthState: z.enum(['unchecked', 'healthy', 'error', 'disconnected']),
})
export type DesktopServiceConnection = z.infer<typeof desktopServiceConnectionSchema>

const serviceRowSchema = z.strictObject({
    slug: z.string().min(1).max(200),
    reason: z.string().max(300).optional(),
    catalog: desktopServiceRequestCatalogSchema,
    connections: z.array(desktopServiceConnectionSchema).max(64).nullable(),
    connectionsStatus: z.enum(['ready', 'unavailable']),
})
const receiptSchema = z.strictObject({
    requestId: z.string().uuid(),
    revision: z.string().uuid(),
    accepted: z.boolean(),
    text: z.string().min(1).max(MAX_SERVICE_CHARS),
    entries: z.array(z.strictObject({
        slug: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        outcome: z.enum(['connected', 'skipped', 'reset', 'not-found']),
    })).max(20),
})
export const desktopServiceRequestViewSchema = z.strictObject({
    request: z.strictObject({
        serviceRequestId: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.string().uuid(),
        source: desktopServiceRequestGuardSchema,
        currentIndex: z.number().int().min(0).max(19),
        choices: z.array(desktopServiceChoiceSchema).min(1).max(20),
        services: z.array(serviceRowSchema).min(1).max(20),
        retry: z.strictObject({
            phase: z.enum(['open', 'finishing', 'accepted']),
            requestId: z.string().uuid().optional(),
        }),
        receipt: receiptSchema.optional(),
    }).nullable(),
})
export type DesktopServiceRequestView = z.infer<typeof desktopServiceRequestViewSchema>
export const desktopServiceProgressResultSchema = z.strictObject({
    serviceRequestId: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string().uuid(),
    currentIndex: z.number().int().min(0).max(19),
    choices: z.array(desktopServiceChoiceSchema).min(1).max(20),
})
export type DesktopServiceProgressResult = z.infer<typeof desktopServiceProgressResultSchema>

export type DesktopServiceRequestParse =
    | { ok: true; services: ServiceSuggestionItem[] }
    | { ok: false; reason: 'duplicate-slug' | 'invalid' }
export type DesktopServiceRequest = DesktopServiceRequestGuard & { services: ServiceSuggestionItem[]; requestedAt?: string | null }
export type DesktopServiceRequestRow = { id: string; role: string; contentJson: string; toolCallsJson?: string | null; createdAt?: string | null }
export type DesktopServiceCatalogFact =
    | { status: 'unavailable' }
    | { status: 'not-found' }
    | { status: 'unsupported-auth' | 'available'; name: string }
export type DesktopServiceInstallFact = {
    key: string
    revision: string
    slug: string
    usable: boolean
    disconnected: boolean
    changing: boolean
}
export type DesktopServiceSetupEntry = { slug: string; name: string; outcome: ServiceSetupOutcome }
export type DesktopServiceDerivation =
    | { ok: true; entries: DesktopServiceSetupEntry[] }
    | { ok: false; reason: 'pending' | 'unavailable' | 'installation-rejected' | 'choice-mismatch' | 'changing' }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function json(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch { return value }
}

export function desktopServiceRequestFingerprint(services: readonly ServiceSuggestionItem[]): string {
    return JSON.stringify(services.map(item => item.reason === undefined ? { slug: item.slug } : { slug: item.slug, reason: item.reason }))
}

// Reject duplicate slugs here. `pendingServices` keeps them, and dropping them would hide an app the model asked for.
export function parseDesktopServiceRequestInput(raw: unknown): DesktopServiceRequestParse {
    const input = record(json(raw))
    const batch = json(input.services)
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 20) return { ok: false, reason: 'invalid' }
    const services: ServiceSuggestionItem[] = []
    const seen = new Set<string>()
    for (const value of batch) {
        const item = record(value)
        if (typeof item.slug !== 'string' || item.slug.length < 1 || item.slug.length > 200) return { ok: false, reason: 'invalid' }
        if (parseServiceRegistryKey(item.slug).instanceId) return { ok: false, reason: 'invalid' }
        if (item.reason != null && (typeof item.reason !== 'string' || item.reason.length > 300)) return { ok: false, reason: 'invalid' }
        if (seen.has(item.slug)) return { ok: false, reason: 'duplicate-slug' }
        seen.add(item.slug)
        services.push(typeof item.reason === 'string' ? { slug: item.slug, reason: item.reason } : { slug: item.slug })
    }
    const normalized = pendingServices({ services })
    if (normalized.length !== services.length || normalized.some((item, index) => item.slug !== services[index]?.slug || item.reason !== services[index]?.reason)) return { ok: false, reason: 'invalid' }
    if (desktopServiceRequestFingerprint(services).length > MAX_SERVICE_CHARS) return { ok: false, reason: 'invalid' }
    return { ok: true, services }
}

function delivered(raw: unknown, depth = 0): boolean {
    if (depth > 5) return false
    const value = record(json(raw))
    if (value.isError === true || value.type === 'error-text' || value.type === 'error-json') return false
    if (value.status === 'delivered') return true
    if ((value.type === 'json' || value.type === 'text') && 'value' in value) return delivered(value.value, depth + 1)
    if (value.structuredContent != null && delivered(value.structuredContent, depth + 1)) return true
    if (Array.isArray(value.content)) return value.content.some(part => record(part).type === 'text' && delivered(record(part).text, depth + 1))
    return false
}

// A later user turn or another non-skill tool settles the old card. Match a successful result to its call.
export function findDesktopServiceRequest(rows: readonly DesktopServiceRequestRow[]): DesktopServiceRequest | null {
    let candidate: DesktopServiceRequest | null = null
    let acknowledged = false
    for (const row of rows) {
        if (row.role === 'user') { candidate = null; acknowledged = false; continue }
        const content = json(row.contentJson)
        const legacy = json(row.toolCallsJson)
        const parts = [...(Array.isArray(content) ? content : [content]), ...(Array.isArray(legacy) ? legacy : [])]
        for (const value of parts) {
            const part = record(value)
            const callId = part.toolCallId ?? part.id
            if (part.type === 'tool-result' || (row.role === 'tool' && (part.output !== undefined || part.result !== undefined))) {
                if (candidate && callId === candidate.toolCallId) acknowledged = part.isError !== true && delivered(part.output ?? part.result)
                continue
            }
            if (row.role !== 'assistant' || (part.type !== 'tool-call' && !part.toolName && !part.name && !record(part.function).name)) continue
            const rawName = part.toolName ?? part.name ?? record(part.function).name
            const name = typeof rawName === 'string' ? stripBridgePrefix(rawName) : ''
            if (name === 'skill_propose') continue
            candidate = null
            acknowledged = false
            if (name !== 'suggest_service' || typeof callId !== 'string' || !callId || callId.length > 256 || !row.id || row.id.length > 256) continue
            const parsed = parseDesktopServiceRequestInput(part.input ?? part.args ?? part.arguments ?? record(part.function).arguments)
            if (parsed.ok) candidate = { sourceMessageId: row.id, toolCallId: callId, services: parsed.services, fingerprint: desktopServiceRequestFingerprint(parsed.services), requestedAt: row.createdAt ?? null }
        }
    }
    return acknowledged ? candidate : null
}

// Unsupported authentication stays on its own status. A failed catalog read is unavailable, never not-found.
// Pending is never turned into skip. use-connection is connected only when that saved installation is usable now.
export function deriveDesktopServiceSetup(input: {
    services: readonly { slug: string }[]
    choices: readonly DesktopServiceChoice[]
    catalog: readonly DesktopServiceCatalogFact[]
    installations: readonly DesktopServiceInstallFact[]
}): DesktopServiceDerivation {
    if (input.choices.length !== input.services.length || input.catalog.length !== input.services.length) return { ok: false, reason: 'choice-mismatch' }
    if (input.choices.some((choice, index) => choice.slug !== input.services[index]?.slug)) return { ok: false, reason: 'choice-mismatch' }
    if (input.catalog.some(item => item.status === 'unavailable')) return { ok: false, reason: 'unavailable' }
    if (input.choices.some(choice => choice.choice === 'pending')) return { ok: false, reason: 'pending' }
    const entries: DesktopServiceSetupEntry[] = []
    for (let index = 0; index < input.services.length; index++) {
        const slug = input.services[index]!.slug
        const fact = input.catalog[index]!
        const choice = input.choices[index]!
        const related = input.installations.filter(item => item.slug === slug)
        if (related.some(item => item.changing)) return { ok: false, reason: 'changing' }
        if (choice.choice === 'use-connection') {
            const selected = choice.installation
            const match = related.find(item => item.key === selected.key && item.revision === selected.revision)
            if (!match?.usable) return { ok: false, reason: 'installation-rejected' }
            entries.push(fact.status === 'not-found' ? { slug, name: slug, outcome: 'not-found' } : { slug, name: fact.name, outcome: 'connected' })
            continue
        }
        entries.push(fact.status === 'not-found'
            ? { slug, name: slug, outcome: 'not-found' }
            : { slug, name: fact.name, outcome: related.some(item => item.disconnected) ? 'reset' : 'skipped' })
    }
    return { ok: true, entries }
}
