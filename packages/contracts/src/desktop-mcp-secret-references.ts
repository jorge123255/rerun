import { z } from 'zod'
import { MCP_SERVER_NAME_RE } from './agent.js'

// Mac subset of the engine resolver in apps/engine/src/tools/mcp-resolve.ts and the
// nonsecret proposal rules in desktop-self-mcp.ts. Missing placeholders stay pending.
// They are never rewritten to an empty string, and this module never reads process.env.
// RERUN_HUB_BASE_URL stays on the engine withHubHeaders path.

export const DESKTOP_MCP_SECRET_REFERENCE_GRANT = 'selfMcpRegister' as const
export const DESKTOP_MCP_SECRET_REFERENCE_PENDING_OUTCOME = 'applied_pending_credentials' as const

export const DESKTOP_MCP_SECRET_REFERENCE_LIMITS = {
    headers: 32,
    headerName: 128,
    headerTemplate: 512,
    literalHeader: 8192,
    resolvedValue: 8192,
    env: 32,
    args: 64,
    argReferences: 32,
    envReferences: 32,
    headerReferences: 32,
    arg: 1024,
    command: 1024,
    url: 2048,
    secretName: 64,
    origin: 256,
    saveId: 128,
    agentId: 128,
    canonicalBytes: 32768,
} as const

export const DESKTOP_MCP_SECRET_REFERENCE_SUPPORT = {
    supported: [
        'HTTPS HTTP or SSE header value with exactly one ${NAME} in the self-MCP header template charset',
        'environment value that is exactly ${NAME}',
        'argument that is exactly ${NAME}',
        'literal header, environment, and argument values that contain no ${',
        'one Authorization authority: reference, bearer literal, OAuth, or anonymous',
        'same-origin redirect check against the saved URL, with an optional SSE session id',
        'coworker secret versions opened only through the canonical credential store',
    ],
    unsupported: [
        'engine empty-string substitution for a missing placeholder',
        'multiple ${} placeholders in one value',
        '${} inside a URL',
        '${} inside a command',
        '${} inside a header name or environment name',
        'embedded ${NAME} inside an argument or environment value',
        'stdio HTTP header references',
        'RERUN_HUB_BASE_URL or any other process.env fallback in this resolver',
        'nested placeholders and names outside [A-Za-z_][A-Za-z0-9_]*',
        'cross-owner references',
        'untrusted cross-origin redirects',
        'raw, base64, hex, percent-encoded, or JSON-escaped secret echoes',
    ],
} as const

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const PURE_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const HEADER_TEMPLATE_RE = /^[A-Za-z0-9._~ /=-]*\$\{([A-Za-z_][A-Za-z0-9_]*)\}[A-Za-z0-9._~ /=-]*$/
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const TOKEN_PREFIX_RE = /^(?:sk-|sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|xapp-|glpat-|dop_v1_|shpat_|shpss_|SG\.|AKIA|ASIA|AIza|ya29\.|hf_|nvapi-|pplx-|gsk_|eyJ)/
const SESSION_KEY_RE = /^(?:sessionId|session_id)$/
const SESSION_VALUE_RE = /^[A-Za-z0-9_-]{16,256}$/

export const desktopMcpTransportSchema = z.enum(['stdio', 'sse', 'http'])
export type DesktopMcpSecretTransport = z.infer<typeof desktopMcpTransportSchema>

export const desktopMcpCredentialAuthoritySchema = z.enum(['reference', 'literal', 'oauth', 'anonymous'])
export type DesktopMcpCredentialAuthority = z.infer<typeof desktopMcpCredentialAuthoritySchema>

export const desktopMcpSecretReferenceFieldSchema = z.enum(['header', 'env', 'arg'])
export type DesktopMcpSecretReferenceField = z.infer<typeof desktopMcpSecretReferenceFieldSchema>

const looseConfigSchema = z.object({
    name: z.string(),
    transport: desktopMcpTransportSchema,
    command: z.string().nullable().transform(value => value ?? undefined).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().nullable().transform(value => value ?? undefined).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z.boolean().optional(),
    literalAuthorization: z.boolean().optional(),
    preservedLiteralKeys: z.array(z.object({
        field: desktopMcpSecretReferenceFieldSchema,
        key: z.string().min(1).max(128),
    }).strict()).max(96).optional(),
}).strict()

export type DesktopMcpSecretReferenceConfig = {
    name: string
    transport: DesktopMcpSecretTransport
    command?: string
    args: string[]
    url?: string
    env: Record<string, string>
    headers: Record<string, string>
    oauth: boolean
    literalAuthorization: boolean
    preservedLiteralKeys: { field: DesktopMcpSecretReferenceField; key: string }[]
}

export type DesktopMcpSecretReferenceSlot =
    | { field: DesktopMcpSecretReferenceField; key: string; kind: 'literal'; template: string }
    | {
          field: DesktopMcpSecretReferenceField
          key: string
          kind: 'reference'
          template: string
          name: string
          prefix: string
          suffix: string
      }

export type DesktopMcpSecretReferencePlan = {
    config: DesktopMcpSecretReferenceConfig
    slots: DesktopMcpSecretReferenceSlot[]
    references: Extract<DesktopMcpSecretReferenceSlot, { kind: 'reference' }>[]
    authority: DesktopMcpCredentialAuthority
}

export type DesktopMcpSecretReferenceRequirement = {
    name: string
    field: DesktopMcpSecretReferenceField
    key: string
}

const bindingSchema = z.object({
    agentId: z.string().min(1).max(DESKTOP_MCP_SECRET_REFERENCE_LIMITS.agentId),
    serverName: z.string().regex(MCP_SERVER_NAME_RE),
    configRevision: z.string().min(1).max(200),
    bindingRevision: z.number().int().nonnegative(),
    field: desktopMcpSecretReferenceFieldSchema,
    fieldKey: z.string().min(1).max(128),
    secretName: z.string().regex(SECRET_NAME_RE).max(DESKTOP_MCP_SECRET_REFERENCE_LIMITS.secretName),
    secretVersion: z.number().int().nonnegative().nullable(),
    status: z.enum(['pending', 'bound']),
    origin: z.string().min(1).max(DESKTOP_MCP_SECRET_REFERENCE_LIMITS.origin),
}).strict()
export const desktopMcpSecretBindingSchema = bindingSchema
export type DesktopMcpSecretBinding = z.infer<typeof bindingSchema>

export const desktopMcpSecretReferenceSaveResultSchema = z.object({
    status: z.enum(['saved', 'pending', 'replayed', 'conflict', 'not-saved']),
    saveId: z.string().min(1).max(DESKTOP_MCP_SECRET_REFERENCE_LIMITS.saveId),
    agentId: z.string().min(1).max(DESKTOP_MCP_SECRET_REFERENCE_LIMITS.agentId),
    serverName: z.string().regex(MCP_SERVER_NAME_RE),
    configRevision: z.string().min(1).max(200),
    bindingRevision: z.number().int().nonnegative(),
    authority: desktopMcpCredentialAuthoritySchema,
    pending: z.array(z.string().regex(SECRET_NAME_RE)).max(96),
    bound: z.array(z.object({
        name: z.string().regex(SECRET_NAME_RE),
        version: z.number().int().nonnegative(),
    }).strict()).max(96),
    message: z.string().max(400),
    storedStatus: z.enum(['saved', 'pending']).optional(),
}).strict()
export type DesktopMcpSecretReferenceSaveResult = z.infer<typeof desktopMcpSecretReferenceSaveResultSchema>

type Scan =
    | { ok: true; names: { name: string; start: number; end: number }[] }
    | { ok: false }

function scanPlaceholders(value: string): Scan {
    const names: { name: string; start: number; end: number }[] = []
    let cursor = 0
    while (cursor < value.length) {
        const start = value.indexOf('${', cursor)
        if (start === -1) return { ok: true, names }
        const end = value.indexOf('}', start + 2)
        if (end === -1) return { ok: false }
        const name = value.slice(start + 2, end)
        if (!SECRET_NAME_RE.test(name) || name.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.secretName) return { ok: false }
        names.push({ name, start, end: end + 1 })
        cursor = end + 1
    }
    return { ok: true, names }
}

function sortRecord(record: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function desktopMcpSecretReferenceCanonical(config: DesktopMcpSecretReferenceConfig): string {
    return JSON.stringify({
        name: config.name,
        transport: config.transport,
        command: config.command ?? null,
        args: config.args,
        url: config.url ?? null,
        env: sortRecord(config.env),
        headers: sortRecord(config.headers),
        oauth: config.oauth,
        literalAuthorization: config.literalAuthorization,
        preservedLiteralKeys: config.preservedLiteralKeys
            .map(item => ({ field: item.field, key: item.key }))
            .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    })
}

function normalized(value: z.infer<typeof looseConfigSchema>): DesktopMcpSecretReferenceConfig {
    const config: DesktopMcpSecretReferenceConfig = {
        name: value.name,
        transport: value.transport,
        args: value.args ?? [],
        env: value.env ?? {},
        headers: value.headers ?? {},
        oauth: value.oauth ?? false,
        literalAuthorization: value.literalAuthorization ?? false,
        preservedLiteralKeys: value.preservedLiteralKeys ?? [],
    }
    if (value.command !== undefined) config.command = value.command
    if (value.url !== undefined) config.url = value.url
    return config
}

function headerAuthority(slot: DesktopMcpSecretReferenceSlot | undefined, oauth: boolean, literalAuthorization: boolean): DesktopMcpCredentialAuthority | 'conflict' {
    if (slot?.kind === 'reference' && (oauth || literalAuthorization)) return 'conflict'
    if (slot?.kind === 'literal' && (oauth || literalAuthorization)) return 'conflict'
    if (slot?.kind === 'reference') return 'reference'
    if (slot?.kind === 'literal') return 'literal'
    if (oauth && literalAuthorization) return 'conflict'
    if (oauth) return 'oauth'
    if (literalAuthorization) return 'literal'
    return 'anonymous'
}

function classify(config: DesktopMcpSecretReferenceConfig): { issue: string | null; plan: DesktopMcpSecretReferencePlan | null } {
    if (!MCP_SERVER_NAME_RE.test(config.name)) return { issue: 'Name must be 1-64 characters: letters, digits, underscores, or hyphens.', plan: null }
    const slots: DesktopMcpSecretReferenceSlot[] = []
    const headerNames = new Map<string, string>()
    if (Object.keys(config.headers).length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.headers) return { issue: 'Too many headers.', plan: null }
    if (Object.keys(config.env).length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.env) return { issue: 'Too many environment entries.', plan: null }
    if (config.args.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.args) return { issue: 'Too many arguments.', plan: null }
    if (config.transport === 'stdio' && Object.keys(config.headers).length > 0) {
        return { issue: 'stdio servers cannot carry HTTP headers; put references in arguments or environment.', plan: null }
    }
    if (config.command !== undefined) {
        if (config.command.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.command) return { issue: 'Command is too long.', plan: null }
        if (config.command.includes('${')) return { issue: 'Command must not embed variable references.', plan: null }
    }
    if ((config.transport === 'http' || config.transport === 'sse') && !config.url) return { issue: `MCP server "${config.name}" needs a url for ${config.transport}.`, plan: null }
    if (config.transport === 'stdio' && !config.command) return { issue: `MCP server "${config.name}" needs a command for stdio.`, plan: null }
    if (config.url !== undefined) {
        if (config.url.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.url) return { issue: 'URL is too long.', plan: null }
        if (config.url.includes('${')) return { issue: `MCP server "${config.name}" must not embed variable references in its url; put them in headers instead.`, plan: null }
        let parsed: URL
        try { parsed = new URL(config.url) } catch { return { issue: 'Use an http(s) endpoint without credentials, query or fragment.', plan: null } }
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash) {
            return { issue: 'Use an http(s) endpoint without credentials, query or fragment.', plan: null }
        }
    }

    const take = (field: DesktopMcpSecretReferenceField, key: string, template: string, mode: 'header' | 'pure'): string | null => {
        const scanned = scanPlaceholders(template)
        if (!scanned.ok) return `The placeholder in "${key}" is not a ${'${NAME}'} reference.`
        if (scanned.names.length > 1) return 'Multiple ${NAME} placeholders in one value are not supported.'
        if (scanned.names.length === 0) {
            if (template.includes('${')) return `The placeholder in "${key}" is not a ${'${NAME}'} reference.`
            slots.push({ field, key, kind: 'literal', template })
            return null
        }
        const pattern = mode === 'header' ? HEADER_TEMPLATE_RE : PURE_PLACEHOLDER_RE
        if (!pattern.test(template)) {
            return mode === 'header'
                ? `Header "${key}" must be a fixed template with one ${'${NAME}'} reference.`
                : `${field === 'env' ? 'Environment' : 'Argument'} "${key}" must be exactly ${'${NAME}'}.`
        }
        if (mode === 'header' && template.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.headerTemplate) return `Header "${key}" template is too long.`
        const found = scanned.names[0]!
        slots.push({
            field,
            key,
            kind: 'reference',
            template,
            name: found.name,
            prefix: template.slice(0, found.start),
            suffix: template.slice(found.end),
        })
        return null
    }

    for (const [key, template] of Object.entries(config.headers)) {
        if (!HEADER_KEY_RE.test(key)) return { issue: `Header "${key}" is not a valid HTTP header name.`, plan: null }
        const folded = key.toLowerCase()
        if (headerNames.has(folded)) return { issue: `Header names conflict: ${folded}.`, plan: null }
        headerNames.set(folded, key)
        if (!template.includes('${') && template.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.literalHeader) return { issue: `Header "${key}" is too long.`, plan: null }
        const issue = take('header', key, template, 'header')
        if (issue) return { issue, plan: null }
    }
    for (const [key, template] of Object.entries(config.env)) {
        if (!ENV_KEY_RE.test(key) || key.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.secretName) return { issue: `Environment variable "${key}" is not a valid variable name.`, plan: null }
        if (template.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.arg) return { issue: `Environment variable "${key}" is too long.`, plan: null }
        const issue = take('env', key, template, 'pure')
        if (issue) return { issue, plan: null }
    }
    for (let index = 0; index < config.args.length; index += 1) {
        const template = config.args[index]!
        if (template.length > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.arg) return { issue: 'An argument is too long.', plan: null }
        const issue = take('arg', String(index), template, 'pure')
        if (issue) return { issue, plan: null }
    }

    const references = slots.filter((slot): slot is Extract<DesktopMcpSecretReferenceSlot, { kind: 'reference' }> => slot.kind === 'reference')
    const headerReferences = references.filter(slot => slot.field === 'header').length
    const envReferences = references.filter(slot => slot.field === 'env').length
    const argReferences = references.filter(slot => slot.field === 'arg').length
    if (headerReferences > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.headerReferences) return { issue: 'Too many header references.', plan: null }
    if (envReferences > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.envReferences) return { issue: 'Too many environment references.', plan: null }
    if (argReferences > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.argReferences) return { issue: 'Too many argument references.', plan: null }
    if (references.length > 0 && config.url && !config.url.startsWith('https:')) return { issue: 'Secret references require an HTTPS endpoint.', plan: null }

    const authorizationKey = headerNames.get('authorization')
    const authorization = authorizationKey ? slots.find(slot => slot.field === 'header' && slot.key === authorizationKey) : undefined
    const authorizationClass = headerAuthority(authorization, config.oauth, config.literalAuthorization)
    if (authorizationClass === 'conflict') return { issue: 'Authorization has more than one credential authority.', plan: null }
    const otherLiteral = slots.some(slot => slot.kind === 'literal'
        && !(slot.field === 'header' && slot.key.toLowerCase() === 'authorization')
        && desktopMcpSecretReferenceLooksSecret(slot.template))
    if (otherLiteral && authorizationClass === 'literal') {
        return { issue: 'This server has more than one credential authority. Use a reference, a bearer literal, OAuth, or an anonymous connection.', plan: null }
    }
    const referenceClass = references.length > 0
    const literalClass = authorizationClass === 'literal' || otherLiteral
    const oauthClass = authorizationClass === 'oauth'
    if (Number(referenceClass) + Number(literalClass) + Number(oauthClass) > 1) {
        return { issue: 'This server has more than one credential authority. Use a reference, a bearer literal, OAuth, or an anonymous connection.', plan: null }
    }
    const authority: DesktopMcpCredentialAuthority = referenceClass ? 'reference' : literalClass ? 'literal' : authorizationClass
    return { issue: null, plan: { config, slots, references, authority } }
}

export function desktopMcpSecretReferenceIssue(value: unknown): string | null {
    const parsed = looseConfigSchema.safeParse(value)
    if (!parsed.success) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'Provide an MCP server description as an object.'
        return 'The MCP server description has an unsupported field or type.'
    }
    return classify(normalized(parsed.data)).issue
}

export function desktopMcpSecretReferencePlan(value: unknown): DesktopMcpSecretReferencePlan | null {
    const parsed = looseConfigSchema.safeParse(value)
    if (!parsed.success) return null
    return classify(normalized(parsed.data)).plan
}

export function desktopMcpSecretReferenceLooksSecret(value: string): boolean {
    const candidate = value.trim()
    if (/^bearer\s+\S/i.test(candidate)) return true
    if (candidate.length < 12 || /\s/.test(candidate) || candidate.includes('://')) return false
    if (TOKEN_PREFIX_RE.test(candidate)) return true
    return candidate.length >= 24 && /^[A-Za-z0-9_\-.+/=]+$/.test(candidate) && /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /\d/.test(candidate)
}

export function desktopMcpSecretReferencePublicIssue(value: unknown): string | null {
    const issue = desktopMcpSecretReferenceIssue(value)
    if (issue) return issue
    const plan = desktopMcpSecretReferencePlan(value)
    if (!plan) return 'The MCP server description is not valid.'
    for (const slot of plan.slots) {
        if (slot.kind !== 'literal') continue
        if (slot.field === 'header' && slot.key.toLowerCase() === 'authorization') {
            return 'Header "Authorization" must be a ${NAME} template here. Existing bearer credentials stay in MCP server settings and are not shown.'
        }
        if (desktopMcpSecretReferenceLooksSecret(slot.template)) return `Value for "${slot.key}" looks like an inline secret. Reference it as ${'${NAME}'}.`
    }
    if (new TextEncoder().encode(desktopMcpSecretReferenceCanonical(plan.config)).byteLength > DESKTOP_MCP_SECRET_REFERENCE_LIMITS.canonicalBytes) return 'The public MCP description is too long.'
    return null
}

export function desktopMcpRegistrationLink(value: unknown):
    | { accepted: false; outcome: typeof DESKTOP_MCP_SECRET_REFERENCE_PENDING_OUTCOME; pending: string[]; authority: DesktopMcpCredentialAuthority }
    | { accepted: false; outcome: 'ready_without_references'; pending: []; authority: DesktopMcpCredentialAuthority }
    | { accepted: false; outcome: 'rejected'; issue: string } {
    const issue = desktopMcpSecretReferenceIssue(value)
    if (issue) return { accepted: false, outcome: 'rejected', issue }
    const plan = desktopMcpSecretReferencePlan(value)
    if (!plan) return { accepted: false, outcome: 'rejected', issue: 'The MCP server description is not valid.' }
    const pending = [...new Set(plan.references.map(reference => reference.name))]
    if (pending.length > 0) return { accepted: false, outcome: DESKTOP_MCP_SECRET_REFERENCE_PENDING_OUTCOME, pending, authority: plan.authority }
    return { accepted: false, outcome: 'ready_without_references', pending: [], authority: plan.authority }
}

export function desktopMcpSecretReferenceReview(value: unknown): {
    headerText: string
    envText: string
    argText: string
    notes: string[]
    requirements: DesktopMcpSecretReferenceRequirement[]
    hiddenKeys: { field: DesktopMcpSecretReferenceField; key: string }[]
} | null {
    const plan = desktopMcpSecretReferencePlan(value)
    if (!plan) return null
    const notes: string[] = []
    const hiddenKeys: { field: DesktopMcpSecretReferenceField; key: string }[] = []
    const headerLines: string[] = []
    const envLines: string[] = []
    const argLines: string[] = []
    if (plan.config.literalAuthorization || plan.slots.some(slot => slot.field === 'header' && slot.key.toLowerCase() === 'authorization' && slot.kind === 'literal')) {
        notes.push('Bearer credential configured.')
    }
    if (plan.config.oauth) notes.push('Sign-in is managed by the existing MCP settings.')
    for (const slot of plan.slots) {
        if (slot.kind === 'literal' && slot.field === 'header' && slot.key.toLowerCase() === 'authorization') {
            hiddenKeys.push({ field: slot.field, key: slot.key })
            continue
        }
        if (slot.kind === 'literal' && desktopMcpSecretReferenceLooksSecret(slot.template)) {
            hiddenKeys.push({ field: slot.field, key: slot.key })
            notes.push(`A stored value for "${slot.key}" stays hidden.`)
            continue
        }
        if (slot.field === 'header') headerLines.push(`${slot.key}=${slot.template}`)
        else if (slot.field === 'env') envLines.push(`${slot.key}=${slot.template}`)
        else argLines.push(slot.template)
    }
    return {
        headerText: headerLines.join('\n'),
        envText: envLines.join('\n'),
        argText: argLines.join('\n'),
        notes,
        requirements: plan.references.map(reference => ({ name: reference.name, field: reference.field, key: reference.key })),
        hiddenKeys,
    }
}

export function desktopMcpSecretReferenceRedirectIssue(savedUrl: string, nextUrl: string): string | null {
    if (savedUrl.includes('${') || nextUrl.includes('${')) return 'Redirects cannot carry variable references.'
    let saved: URL
    let next: URL
    try {
        saved = new URL(savedUrl)
        next = new URL(nextUrl, saved)
    } catch {
        return 'Redirect target is not a valid URL.'
    }
    if (saved.username || saved.password || saved.hash || next.username || next.password || next.hash) return 'Redirects cannot carry credentials or fragments.'
    if (saved.origin !== next.origin) return 'Redirect target is not the saved endpoint origin.'
    if (saved.protocol !== 'https:' && saved.protocol !== 'http:') return 'Redirects stay on the saved http(s) endpoint.'
    if (next.protocol !== saved.protocol) return 'Redirect target is not the saved endpoint origin.'
    const names = [...next.searchParams.keys()]
    if (names.length > 1) return 'Redirect query is not a single SSE session id.'
    if (names.length === 1) {
        const key = names[0]!
        const session = next.searchParams.get(key) ?? ''
        if (!SESSION_KEY_RE.test(key) || !SESSION_VALUE_RE.test(session)) return 'Redirect query is not a single SSE session id.'
    }
    return null
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeBase64(bytes: Uint8Array): string {
    let out = ''
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index] ?? 0
        const second = index + 1 < bytes.length ? bytes[index + 1]! : 0
        const third = index + 2 < bytes.length ? bytes[index + 2]! : 0
        const triple = (first << 16) | (second << 8) | third
        out += BASE64_ALPHABET[(triple >> 18) & 63]
        out += BASE64_ALPHABET[(triple >> 12) & 63]
        out += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : '='
        out += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : '='
    }
    return out
}

function encodeHex(bytes: Uint8Array): string {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function needlesFor(bytes: Uint8Array): string[] {
    if (bytes.byteLength === 0) return []
    const needles = new Set<string>()
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const utf8 = new TextEncoder().encode(text)
    const same = utf8.byteLength === bytes.byteLength && utf8.every((byte, index) => byte === bytes[index])
    if (same && text.length > 0) {
        needles.add(text)
        const escaped = JSON.stringify(text).slice(1, -1)
        if (escaped.length > 0) needles.add(escaped)
        const encoded = encodeURIComponent(text)
        if (encoded.length > 0) needles.add(encoded)
    }
    const base64 = encodeBase64(bytes)
    needles.add(base64)
    needles.add(base64.replace(/=+$/u, '').replaceAll('+', '-').replaceAll('/', '_'))
    const hex = encodeHex(bytes)
    if (hex.length > 0) {
        needles.add(hex)
        needles.add(hex.toUpperCase())
    }
    return [...needles].filter(needle => needle.length > 0).sort((a, b) => b.length - a.length)
}

export function redactDesktopMcpSecretText(text: string, materials: readonly Uint8Array[]): string {
    let redacted = text
    for (const bytes of materials) {
        for (const needle of needlesFor(bytes)) redacted = redacted.split(needle).join('[redacted]')
    }
    return redacted
}

export function redactDesktopMcpSecretValue<T>(value: T, materials: readonly Uint8Array[]): T {
    const seen = new WeakMap<object, unknown>()
    const active = new WeakSet<object>()
    const visit = (input: unknown): unknown => {
        if (typeof input === 'string') return redactDesktopMcpSecretText(input, materials)
        if (!input || typeof input !== 'object') return input
        if (active.has(input)) return '[redacted cycle]'
        if (seen.has(input)) return seen.get(input)
        const output: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : Object.create(null)
        seen.set(input, output)
        active.add(input)
        if (Array.isArray(input)) for (const entry of input) (output as unknown[]).push(visit(entry))
        else for (const [key, entry] of Object.entries(input)) (output as Record<string, unknown>)[redactDesktopMcpSecretText(key, materials)] = visit(entry)
        active.delete(input)
        return output
    }
    return visit(value) as T
}

export function desktopMcpSecretReferenceError(code: 'missing' | 'rotated' | 'invalid' | 'forbidden', name?: string): { code: 'missing' | 'rotated' | 'invalid' | 'forbidden'; name?: string; message: string } {
    const label = name && SECRET_NAME_RE.test(name) ? name : 'credential'
    const message = code === 'missing'
        ? `Credential ${label} is not saved for this coworker.`
        : code === 'rotated'
            ? `Credential ${label} changed. Reconnect after the current MCP work finishes.`
            : code === 'forbidden'
                ? `Credential ${label} is not available to this coworker.`
                : `Credential reference ${label} is not supported.`
    return name ? { code, name, message } : { code, message }
}

const saveObject = z.object({
    saveId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    agentId: z.string().min(1).max(DESKTOP_MCP_SECRET_REFERENCE_LIMITS.agentId),
    serverName: z.string().regex(MCP_SERVER_NAME_RE),
    expectedConfigRevision: z.string().min(1).max(200),
    expectedBindingRevision: z.number().int().nonnegative(),
    origin: z.string().min(1).max(DESKTOP_MCP_SECRET_REFERENCE_LIMITS.origin).refine(origin => !/[\u0000-\u0020\u007f]/u.test(origin) && !origin.includes('${')),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    config: looseConfigSchema,
}).strict()

export const desktopMcpSecretReferenceSaveSchema = saveObject
export type DesktopMcpSecretReferenceSave = z.infer<typeof saveObject>

export function desktopMcpSecretReferencePublicConfig(value: unknown): DesktopMcpSecretReferenceConfig | null {
    if (desktopMcpSecretReferencePublicIssue(value)) return null
    return desktopMcpSecretReferencePlan(value)?.config ?? null
}

export type DesktopMcpSecretReferenceOwner = {
    agentId: string
    enabled: boolean
    deleting: boolean
    selfMcpGranted: boolean
    localMcpStdioGranted: boolean
}

export type DesktopMcpSecretReferenceAuthority = {
    currentOwner(agentId: string): Promise<DesktopMcpSecretReferenceOwner | null>
}

export type DesktopMcpSecretReferencePhase = 'discovery' | 'invocation'
