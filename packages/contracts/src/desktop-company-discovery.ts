import { z } from 'zod'
import type { DesktopForemanDiscoveryEvent, DesktopForemanFinding } from './desktop-foreman.js'
import { foremanDiscoveryEventSchema } from './desktop-foreman.js'

// Local company discovery (E11). B reads this snapshot. It does not synthesize a profile and it
// does not write Brain pages. Version 1. The barrel export is a root fragment, not applied here.
// Identifiers match the Foreman binding: workspace, chat `fmc_`, run, discovery `fmx_`.

export const DESKTOP_COMPANY_DISCOVERY_CONTRACT_VERSION = 1 as const

export const DESKTOP_COMPANY_DISCOVERY_LIMITS = {
    maxRetries: 20,
    maxPages: 4,
    maxProductReads: 4,
    maxProducts: 25,
    maxCollections: 20,
    maxFindings: 24,
    maxTools: 12,
    maxItems: 6,
    maxConcurrent: 2,
    maxProvenance: 8,
    maxHtmlChars: 200_000,
    maxPageTextChars: 8_000,
    maxOfficers: 3,
    pageDeadlineMs: 8_000,
    runDeadlineMs: 45_000,
} as const

export const COMPANY_DISCOVERY_SOURCES = ['profile', 'dns', 'stack', 'site', 'search', 'registry', 'linkedinPerson', 'linkedinCompany', 'googleBusiness', 'catalog', 'synthesis'] as const
export const companyDiscoverySourceSchema = z.enum(COMPANY_DISCOVERY_SOURCES)
export type CompanyDiscoverySource = z.infer<typeof companyDiscoverySourceSchema>

// Collectors this desktop can run from public DNS and confined HTTP. The others need a paid
// provider or the welcome card's own quick read, and are reported unavailable.
export const COMPANY_DISCOVERY_LOCAL_SOURCES = ['dns', 'stack', 'site', 'registry', 'catalog'] as const
export const COMPANY_DISCOVERY_CREDENTIALED_SOURCES = ['search', 'linkedinPerson', 'linkedinCompany', 'googleBusiness', 'synthesis'] as const

export const COMPANY_DISCOVERY_ORIGINAL_BILLING: Record<CompanyDiscoverySource, 'free' | 'firecrawl' | 'apify' | 'llm' | 'welcome'> = {
    profile: 'welcome',
    dns: 'free',
    stack: 'free',
    site: 'firecrawl',
    search: 'firecrawl',
    registry: 'free',
    linkedinPerson: 'apify',
    linkedinCompany: 'apify',
    googleBusiness: 'apify',
    catalog: 'firecrawl',
    synthesis: 'llm',
}

export const COMPANY_DISCOVERY_SOURCE_LABELS: Record<CompanyDiscoverySource, string> = {
    profile: 'Your website',
    stack: 'Your website',
    site: 'Your website',
    dns: 'Your domain',
    registry: 'Public registry',
    search: 'The web',
    linkedinPerson: 'LinkedIn',
    linkedinCompany: 'LinkedIn',
    googleBusiness: 'Google',
    catalog: 'Your website',
    synthesis: 'Rerun',
}

export const COMPANY_DISCOVERY_TEASERS: Record<CompanyDiscoverySource, (subject: { name: string; domain: string }) => string> = {
    profile: ({ domain }) => `Reading ${domain}…`,
    stack: ({ domain }) => `Peeking under the hood of ${domain}…`,
    dns: () => 'Checking how you run email…',
    registry: () => 'Looking you up in the public registry…',
    site: ({ domain }) => `Reading pages from ${domain}…`,
    search: ({ name }) => `Searching the web for ${name}…`,
    linkedinPerson: () => 'Looking for you on LinkedIn…',
    linkedinCompany: ({ name }) => `Finding ${name} on LinkedIn…`,
    googleBusiness: () => 'Reading your Google reviews…',
    catalog: ({ domain }) => `Browsing the ${domain} shop…`,
    synthesis: () => 'Piecing it all together…',
}

const opaque = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9-]{8,80}$`))
export const companyWorkspaceIdSchema = z.string().min(1).max(128)
export const companyChatIdSchema = opaque('fmc')
export const companyRunIdSchema = z.string().min(1).max(128)
export const companyDiscoveryIdSchema = opaque('fmx')

const attributionSchema = z.strictObject({
    url: z.string().min(1).max(2048),
    fetchedAt: z.string().min(1).max(40),
    via: z.enum(['public-fetch', 'public-dns', 'public-registry', 'bundled-catalog', 'synthesis']),
})
export type CompanyDiscoveryAttribution = z.infer<typeof attributionSchema>

const toolSchema = z.strictObject({ name: z.string().min(1).max(80), iconUrl: z.string().max(2048).nullable() })
const networkSchema = z.strictObject({ name: z.string().min(1).max(40), iconUrl: z.string().max(2048).nullable(), audience: z.string().max(80).nullable() })

export const companyFindingSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('identity'), source: companyDiscoverySourceSchema, attribution: attributionSchema, name: z.string().min(1).max(200), oneLiner: z.string().max(400).nullable(), logoUrl: z.string().max(2048).nullable(), domain: z.string().min(1).max(253) }),
    z.strictObject({ kind: z.literal('audience'), source: companyDiscoverySourceSchema, attribution: attributionSchema, text: z.string().min(1).max(400) }),
    z.strictObject({ kind: z.literal('tools'), source: companyDiscoverySourceSchema, attribution: attributionSchema, tools: z.array(toolSchema).min(1).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxTools) }),
    z.strictObject({ kind: z.literal('mail'), source: companyDiscoverySourceSchema, attribution: attributionSchema, provider: z.string().min(1).max(80), iconUrl: z.string().max(2048).nullable() }),
    z.strictObject({ kind: z.literal('social'), source: companyDiscoverySourceSchema, attribution: attributionSchema, networks: z.array(networkSchema).min(1).max(9) }),
    z.strictObject({ kind: z.literal('brand'), source: companyDiscoverySourceSchema, attribution: attributionSchema, colors: z.array(z.string().max(20)).min(1).max(5), fonts: z.array(z.string().max(80)).max(2) }),
    z.strictObject({ kind: z.literal('registry'), source: companyDiscoverySourceSchema, attribution: attributionSchema, founded: z.string().max(10).nullable(), headcount: z.string().max(40).nullable(), city: z.string().max(80).nullable() }),
    z.strictObject({ kind: z.literal('person'), source: companyDiscoverySourceSchema, attribution: attributionSchema, name: z.string().min(1).max(200), headline: z.string().max(240).nullable(), photoUrl: z.string().max(2048).nullable() }),
    z.strictObject({ kind: z.literal('linkedin'), source: companyDiscoverySourceSchema, attribution: attributionSchema, followers: z.number().int().nonnegative().nullable(), employees: z.number().int().nonnegative().nullable() }),
    z.strictObject({ kind: z.literal('reviews'), source: companyDiscoverySourceSchema, attribution: attributionSchema, rating: z.number().min(0).max(5), count: z.number().int().nonnegative() }),
    z.strictObject({ kind: z.literal('products'), source: companyDiscoverySourceSchema, attribution: attributionSchema, items: z.array(z.string().min(1).max(120)).min(1).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxItems) }),
    z.strictObject({ kind: z.literal('competitors'), source: companyDiscoverySourceSchema, attribution: attributionSchema, items: z.array(z.string().min(1).max(120)).min(1).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxItems) }),
    z.strictObject({ kind: z.literal('customers'), source: companyDiscoverySourceSchema, attribution: attributionSchema, items: z.array(z.string().min(1).max(120)).min(1).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxItems) }),
    z.strictObject({ kind: z.literal('brain'), source: companyDiscoverySourceSchema, attribution: attributionSchema, pages: z.number().int().nonnegative(), topics: z.array(z.string().max(80)).max(12).optional(), products: z.number().int().nonnegative().optional(), competitors: z.number().int().nonnegative().optional() }),
])
export type CompanyFinding = z.infer<typeof companyFindingSchema>

export const companyProvenanceSchema = z.strictObject({
    url: z.string().min(1).max(2048),
    fetchedAt: z.string().min(1).max(40),
    via: z.enum(['public-fetch', 'public-dns', 'public-registry', 'bundled-catalog']),
    status: z.number().int().min(0).max(599).nullable(),
})
export type CompanyProvenance = z.infer<typeof companyProvenanceSchema>

const dnsPayloadSchema = z.strictObject({
    mailProvider: z.string().max(80).nullable(),
    mx: z.array(z.string().max(253)).max(20),
    services: z.array(z.strictObject({ name: z.string().max(80), evidence: z.string().max(160) })).max(30),
    spfIncludes: z.array(z.string().max(253)).max(20),
    dmarcPolicy: z.string().max(40).nullable(),
})
const stackPayloadSchema = z.strictObject({
    finalUrl: z.string().max(2048),
    truncated: z.boolean(),
    technologies: z.array(z.strictObject({ name: z.string().max(80), category: z.string().max(40) })).max(40),
    meta: z.strictObject({ title: z.string().max(300).nullable(), description: z.string().max(400).nullable(), siteName: z.string().max(200).nullable() }),
    social: z.array(z.string().max(40)).max(9),
})
const sitePayloadSchema = z.strictObject({
    truncated: z.boolean(),
    pages: z.array(z.strictObject({ category: z.string().max(20), url: z.string().max(2048), title: z.string().max(300).nullable(), text: z.string().max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxPageTextChars).optional() })).max(8),
    productUrls: z.array(z.string().max(2048)).max(20),
    social: z.array(z.string().max(40)).max(9),
    colors: z.array(z.string().max(20)).max(5),
    fonts: z.array(z.string().max(80)).max(2),
    failedPages: z.array(z.strictObject({ url: z.string().max(2048), reason: z.string().max(40) })).max(8),
})
const registryPayloadSchema = z.strictObject({
    matchedBy: z.literal('siren'),
    query: z.string().regex(/^\d{9}$/),
    company: z.strictObject({
        siren: z.string().regex(/^\d{9}$/),
        name: z.string().max(200),
        naf: z.string().max(16).nullable(),
        category: z.string().max(40).nullable(),
        founded: z.string().max(10).nullable(),
        headcount: z.string().max(40).nullable(),
        city: z.string().max(80).nullable(),
        active: z.boolean(),
        officers: z.array(z.strictObject({ name: z.string().max(160), role: z.string().max(80).nullable() })).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxOfficers),
    }).nullable(),
})
const catalogPayloadSchema = z.strictObject({
    platform: z.string().max(40).nullable(),
    shopUrl: z.string().max(2048),
    total: z.number().int().nonnegative().nullable(),
    totalIsLowerBound: z.boolean(),
    collections: z.array(z.string().max(60)).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxCollections),
    products: z.array(z.strictObject({ name: z.string().max(160), url: z.string().max(2048) })).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProducts),
})

export const companyPayloadSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dns'), dns: dnsPayloadSchema }),
    z.strictObject({ kind: z.literal('stack'), stack: stackPayloadSchema }),
    z.strictObject({ kind: z.literal('site'), site: sitePayloadSchema }),
    z.strictObject({ kind: z.literal('registry'), registry: registryPayloadSchema }),
    z.strictObject({ kind: z.literal('catalog'), catalog: catalogPayloadSchema }),
    z.strictObject({ kind: z.literal('none') }),
])
export type CompanyPayload = z.infer<typeof companyPayloadSchema>

export const companySettledReasonSchema = z.enum(['found', 'empty', 'failed', 'timeout', 'blocked', 'malformed', 'oversized', 'private', 'cancelled', 'not-a-shop', 'no-siren'])
export const companySourceStatusSchema = z.enum(['found', 'failed', 'omitted', 'unknown'])

export const companySourceRecordSchema = z.strictObject({
    source: companyDiscoverySourceSchema,
    revision: z.number().int().positive().max(100),
    status: companySourceStatusSchema,
    reason: companySettledReasonSchema,
    fetchedAt: z.string().max(40).nullable(),
    provenance: z.array(companyProvenanceSchema).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProvenance),
    payload: companyPayloadSchema,
    findings: z.array(companyFindingSchema).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxFindings),
})
export type CompanySourceRecord = z.infer<typeof companySourceRecordSchema>

export const companyBoardEntrySchema = z.discriminatedUnion('type', [
    z.strictObject({ id: z.string().max(80), order: z.number(), source: companyDiscoverySourceSchema, type: z.literal('teaser') }),
    z.strictObject({ id: z.string().max(80), order: z.number(), source: companyDiscoverySourceSchema, type: z.literal('finding'), finding: companyFindingSchema, arrival: z.number().int().nonnegative() }),
    z.strictObject({ id: z.string().max(80), order: z.number(), source: companyDiscoverySourceSchema, type: z.literal('unavailable') }),
])
export type CompanyBoardEntry = z.infer<typeof companyBoardEntrySchema>
export const companyBoardSchema = z.strictObject({
    entries: z.array(companyBoardEntrySchema).max(80),
    nextOrder: z.number().int().nonnegative(),
    arrivals: z.number().int().nonnegative(),
    ended: z.boolean(),
})
export type CompanyBoardState = z.infer<typeof companyBoardSchema>

export const companyDiscoverySnapshotSchema = z.strictObject({
    contractVersion: z.literal(DESKTOP_COMPANY_DISCOVERY_CONTRACT_VERSION),
    discoveryId: companyDiscoveryIdSchema,
    workspaceId: companyWorkspaceIdSchema,
    chatId: companyChatIdSchema,
    runId: companyRunIdSchema,
    url: z.string().min(1).max(2048),
    domain: z.string().min(1).max(253),
    status: z.enum(['running', 'done', 'failed', 'stopped', 'unknown']),
    startedAt: z.string().min(1).max(40),
    updatedAt: z.string().min(1).max(40),
    attempt: z.number().int().positive().max(100),
    retries: z.array(z.string().uuid()).max(20),
    pending: z.array(companyDiscoverySourceSchema).max(COMPANY_DISCOVERY_SOURCES.length),
    unavailable: z.array(companyDiscoverySourceSchema).max(COMPANY_DISCOVERY_SOURCES.length),
    findings: z.array(companyFindingSchema).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxFindings),
    sources: z.array(companySourceRecordSchema).max(COMPANY_DISCOVERY_SOURCES.length),
    revisions: z.array(z.strictObject({ source: companyDiscoverySourceSchema, revision: z.number().int().positive() })).max(COMPANY_DISCOVERY_SOURCES.length),
    board: companyBoardSchema,
})
export type DesktopCompanyDiscoverySnapshot = z.infer<typeof companyDiscoverySnapshotSchema>

export const companyDiscoveryEventSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('pending'), source: companyDiscoverySourceSchema }),
    z.strictObject({ type: z.literal('unavailable'), source: companyDiscoverySourceSchema, reason: z.enum(['credentialed', 'welcome-card']) }),
    z.strictObject({
        type: z.literal('settled'),
        source: companyDiscoverySourceSchema,
        revision: z.number().int().positive().max(100),
        status: companySourceStatusSchema,
        reason: companySettledReasonSchema,
        fetchedAt: z.string().max(40).nullable(),
        provenance: z.array(companyProvenanceSchema).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProvenance),
        payload: companyPayloadSchema,
        findings: z.array(companyFindingSchema).max(DESKTOP_COMPANY_DISCOVERY_LIMITS.maxFindings),
    }),
    z.strictObject({ type: z.literal('end') }),
])
export type CompanyDiscoveryEvent = z.infer<typeof companyDiscoveryEventSchema>

export type CompanyDiscoveryIdentity = {
    discoveryId: string
    workspaceId: string
    chatId: string
    runId: string
    url: string
    domain: string
    startedAt: string
}

export function emptyCompanyDiscoverySnapshot(identity: CompanyDiscoveryIdentity): DesktopCompanyDiscoverySnapshot {
    return {
        contractVersion: DESKTOP_COMPANY_DISCOVERY_CONTRACT_VERSION,
        ...identity,
        status: 'running',
        updatedAt: identity.startedAt,
        attempt: 1,
        retries: [],
        pending: [],
        unavailable: [],
        findings: [],
        sources: [],
        revisions: [],
        board: { entries: [], nextOrder: 0, arrivals: 0, ended: false },
    }
}

// Syntactic guard only. DNS and redirects are re-checked by the confined reader before a connection.
export function readCompanyDiscoveryTarget(value: string): { url: string; domain: string } {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error('private_target')
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new Error('private_target')
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error('private_target')
    if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('private_target')
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!host || host.endsWith('.') || host === 'localhost' || /(^|\.)(localhost|local|internal|home|lan|test|invalid|onion)$/.test(host) || isLiteralPrivate(host)) throw new Error('private_target')
    url.hash = ''
    return { url: url.toString(), domain: host.replace(/^www\./, '') }
}

function isLiteralPrivate(host: string): boolean {
    if (host.includes(':')) return host === '::' || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd') || host.includes('%')
    const parts = host.split('.').map(part => Number(part))
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const [a, b, c] = parts
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 192 && (b === 0 && c === 0 || b === 0 && c === 2)) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51 && c === 100) return true
    if (a === 203 && b === 0 && c === 113) return true
    return false
}

const teaserId = (source: CompanyDiscoverySource) => `teaser:${source}`
const findingId = (finding: CompanyFinding) => `finding:${finding.kind}`
const sameFinding = (a: CompanyFinding, b: CompanyFinding) => JSON.stringify(a) === JSON.stringify(b)
const revisionOf = (state: DesktopCompanyDiscoverySnapshot, source: CompanyDiscoverySource) => state.revisions.find(row => row.source === source)?.revision ?? 0

function touch(state: DesktopCompanyDiscoverySnapshot, updatedAt: string | null): DesktopCompanyDiscoverySnapshot {
    return updatedAt ? { ...state, updatedAt } : state
}

function dropTeaser(entries: CompanyBoardEntry[], source: CompanyDiscoverySource): CompanyBoardEntry[] {
    return entries.filter(entry => entry.id !== teaserId(source))
}

// Original applyDiscoveryEvent, plus the desktop unavailable marker. A revision that is not the
// next one is historical or a duplicate and must not move the board or the findings.
export function applyCompanyDiscoveryEvent(state: DesktopCompanyDiscoverySnapshot, event: CompanyDiscoveryEvent, at: string): DesktopCompanyDiscoverySnapshot | null {
    if (event.type === 'end') {
        if (state.status !== 'running' && state.board.ended) return null
        const status = state.status === 'running' ? 'done' : state.status
        return { ...touch(state, at), status, pending: [], board: { ...state.board, ended: true, entries: state.board.entries.filter(entry => entry.type !== 'teaser') } }
    }
    if (event.type === 'unavailable') {
        if (state.unavailable.includes(event.source) && state.board.entries.some(entry => entry.id === `unavailable:${event.source}`)) return null
        const teaser = state.board.entries.find(entry => entry.id === teaserId(event.source))
        const entries = dropTeaser(state.board.entries, event.source)
        const order = teaser?.order ?? state.board.nextOrder
        return {
            ...touch(state, at),
            pending: state.pending.filter(source => source !== event.source),
            unavailable: state.unavailable.includes(event.source) ? state.unavailable : [...state.unavailable, event.source],
            board: {
                ...state.board,
                ended: false,
                nextOrder: teaser ? state.board.nextOrder : state.board.nextOrder + 1,
                entries: [...entries, { id: `unavailable:${event.source}`, order, source: event.source, type: 'unavailable' }],
            },
        }
    }
    if (event.type === 'pending') {
        if (state.pending.includes(event.source) || state.board.entries.some(entry => entry.source === event.source)) return null
        return {
            ...touch(state, at),
            pending: [...state.pending, event.source],
            board: { ...state.board, ended: false, nextOrder: state.board.nextOrder + 1, entries: [...state.board.entries, { id: teaserId(event.source), order: state.board.nextOrder, source: event.source, type: 'teaser' }] },
        }
    }
    if (event.revision !== revisionOf(state, event.source) + 1) return null
    if (event.findings.some(finding => finding.source !== event.source)) return null
    const record: CompanySourceRecord = {
        source: event.source,
        revision: event.revision,
        status: event.status,
        reason: event.reason,
        fetchedAt: event.fetchedAt,
        provenance: event.provenance,
        payload: event.payload,
        findings: event.findings,
    }
    const sources = [...state.sources.filter(row => row.source !== event.source), record]
    const revisions = [...state.revisions.filter(row => row.source !== event.source), { source: event.source, revision: event.revision }]
    const pending = state.pending.filter(source => source !== event.source)
    const teaserOrder = state.board.entries.find(entry => entry.id === teaserId(event.source))?.order
    let entries = dropTeaser(state.board.entries, event.source)
    let nextOrder = state.board.nextOrder
    let arrivals = state.board.arrivals
    let findings = state.findings
    if (event.findings.length) {
        const kinds = new Set(event.findings.map(finding => finding.kind))
        findings = [...state.findings.filter(finding => !kinds.has(finding.kind)), ...event.findings].slice(0, DESKTOP_COMPANY_DISCOVERY_LIMITS.maxFindings)
        event.findings.forEach((finding, rank) => {
            const id = findingId(finding)
            const existing = entries.findIndex(entry => entry.id === id)
            const current = entries[existing]
            if (current?.type === 'finding' && sameFinding(current.finding, finding)) return
            const arrival = arrivals++
            const order = existing >= 0 ? entries[existing].order : teaserOrder !== undefined ? teaserOrder + rank / event.findings.length : nextOrder++
            const row: CompanyBoardEntry = { id, order, source: event.source, type: 'finding', finding, arrival }
            if (existing >= 0) entries[existing] = row
            else entries.push(row)
        })
    }
    return {
        ...touch(state, at),
        pending,
        sources,
        revisions,
        findings,
        board: { ...state.board, entries, nextOrder, arrivals, ended: false },
    }
}

// What B and the board render. Reading it does not start a fetch or advance a source revision.
export function companyDiscoveryBoard(snapshot: DesktopCompanyDiscoverySnapshot): CompanyBoardEntry[] {
    return [...snapshot.board.entries].sort((a, b) => a.order - b.order)
}

const FOREMAN_KINDS = new Set(['identity', 'audience', 'products', 'customers', 'competitors'])

function projectFinding(finding: CompanyFinding): DesktopForemanFinding | null {
    if (!FOREMAN_KINDS.has(finding.kind)) return null
    let url: string
    try {
        const parsed = new URL(finding.attribution.url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
        url = parsed.toString()
    } catch {
        return null
    }
    const attribution = { url, fetchedAt: finding.attribution.fetchedAt }
    if (finding.kind === 'identity') return { kind: 'identity', source: finding.source, attribution, name: finding.name, oneLiner: finding.oneLiner, logoUrl: null, domain: finding.domain }
    if (finding.kind === 'audience') return { kind: 'audience', source: finding.source, attribution, text: finding.text }
    if (finding.kind === 'products' || finding.kind === 'customers' || finding.kind === 'competitors') return { kind: finding.kind, source: finding.source, attribution, items: finding.items }
    return null
}

// The live Foreman channel only accepts the kinds already on its contract. Mail, tools, social,
// brand and registry stay on this snapshot for B and the board.
export function toForemanDiscoveryEvent(event: CompanyDiscoveryEvent): DesktopForemanDiscoveryEvent | null {
    if (event.type === 'pending') return foremanDiscoveryEventSchema.parse({ type: 'pending', source: event.source })
    if (event.type === 'unavailable') return foremanDiscoveryEventSchema.parse({ type: 'unavailable', source: event.source })
    if (event.type === 'end') return foremanDiscoveryEventSchema.parse({ type: 'end' })
    if (event.status === 'failed') {
        const reason = event.reason === 'timeout' || event.reason === 'cancelled' ? 'timeout' : event.reason === 'blocked' || event.reason === 'private' ? 'blocked' : 'failed'
        return foremanDiscoveryEventSchema.parse({ type: 'dropped', source: event.source, reason })
    }
    const findings = event.findings.flatMap(finding => {
        const projected = projectFinding(finding)
        return projected ? [projected] : []
    }).slice(0, 24)
    if (!findings.length) return foremanDiscoveryEventSchema.parse({ type: 'dropped', source: event.source, reason: 'empty' })
    return foremanDiscoveryEventSchema.parse({ type: 'found', source: event.source, findings })
}
