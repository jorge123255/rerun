import { z } from 'zod'
import { brainPageTypeSchema, brainSlugSchema } from './brain.js'
import {
    foremanChatIdSchema,
    foremanDiscoveryRunSchema,
    foremanWorkspaceIdSchema,
    type DesktopForemanDiscoveryRun,
    type DesktopForemanFinding,
} from './desktop-foreman.js'

// Company research synthesis (E11 / D8). The immutable input is the published Foreman discovery
// run. This file does not define a second discovery record. Agent A's company-discovery branch
// had not published a further snapshot contract at base 5c0f589b51a8129d097f2b97fc420a8acf859b51.
export const DESKTOP_COMPANY_BRIEF_CONTRACT_VERSION = 1 as const

// Original brief sections (apps/ui/lib/company/explore/synthesize.ts).
export const COMPANY_BRIEF_SECTIONS = ['Overview', 'Offering', 'Customers & market', 'Team', 'Presence & reputation', 'Tools', 'Open questions'] as const
export type CompanyBriefSection = (typeof COMPANY_BRIEF_SECTIONS)[number]

// Original seed pages those sections become. Presence stays on the market page.
export const COMPANY_BRIEF_SECTION_PAGES: Record<CompanyBriefSection, { slug: string; type: z.infer<typeof brainPageTypeSchema>; title: string }> = {
    Overview: { slug: 'company', type: 'company', title: 'Company' },
    Offering: { slug: 'offering', type: 'offering', title: 'Offering' },
    'Customers & market': { slug: 'market', type: 'market', title: 'Market' },
    Team: { slug: 'team', type: 'team', title: 'Team' },
    'Presence & reputation': { slug: 'market', type: 'market', title: 'Market' },
    Tools: { slug: 'stack', type: 'stack', title: 'Stack' },
    'Open questions': { slug: 'open-questions', type: 'note', title: 'Open questions' },
}

// Shown when explorers returned nothing. Original CollectorSkipped message.
export const COMPANY_BRIEF_NO_SOURCES = 'Aucune source à synthétiser'

export const COMPANY_BRIEF_AGENT_ID = 'company-brief'
export const COMPANY_BRIEF_AGENT_NAME = 'Company research'
export const COMPANY_BRIEF_PROPOSAL_REASON = 'Approved from the company brief review.'

// Providers the desktop can call with the user's own connected key. `rerun`, `claude` and `codex`
// are not a fallback for this brief.
export const COMPANY_BRIEF_MODEL_PROVIDERS = ['openai', 'anthropic', 'google', 'openrouter'] as const
export const companyBriefModelSchema = z.strictObject({
    connectionId: z.string().min(1).max(256),
    provider: z.enum(COMPANY_BRIEF_MODEL_PROVIDERS),
    model: z.string().min(1).max(512),
    source: z.enum(['workspace', 'coworker', 'conversation']),
    agentId: z.string().min(1).max(128).nullable(),
})
export type CompanyBriefModelRef = z.infer<typeof companyBriefModelSchema>

export const companyBriefClaimSchema = z.strictObject({
    id: z.string().min(1).max(80),
    section: z.enum(COMPANY_BRIEF_SECTIONS),
    text: z.string().min(1).max(2000),
    sources: z.array(z.string().min(1).max(80)).min(1).max(4),
    links: z.array(z.strictObject({ tag: z.string().min(1).max(80), url: z.url().max(2048) })).max(4),
})
export type CompanyBriefClaim = z.infer<typeof companyBriefClaimSchema>

const blank = z.string().max(2000)
export const companyBriefCardSchema = z.strictObject({
    company: z.strictObject({
        name: z.string().max(200), legalName: blank, oneLiner: z.string().max(400), description: blank,
        industry: blank, founded: z.string().max(80), headcount: z.string().max(80), headquarters: z.string().max(200), siren: z.string().max(32),
    }),
    person: z.strictObject({
        name: blank, role: blank, headline: z.string().max(400), location: z.string().max(200), linkedinUrl: z.string().max(500), background: blank, photoUrl: z.string().max(500).nullable(),
    }),
    offering: z.strictObject({ products: z.array(z.string().max(120)).max(12), pricing: z.string().max(500), businessModel: z.string().max(300) }),
    market: z.strictObject({
        audience: z.string().max(400), idealCustomer: z.string().max(400),
        notableCustomers: z.array(z.string().max(120)).max(12), competitors: z.array(z.string().max(120)).max(12),
    }),
    presence: z.strictObject({
        channels: z.array(z.strictObject({ network: z.string().max(80), url: z.string().max(2048), audience: z.string().max(80) })).max(12),
        reputation: z.string().max(500),
    }),
    stack: z.array(z.string().max(80)).max(24),
    voice: z.strictObject({ tone: z.string().max(200), language: z.string().max(80) }),
    unknowns: z.array(z.string().max(300)).max(40),
    branding: z.strictObject({ logo: z.string().max(2048).nullable(), colors: z.array(z.string().max(40)).max(12), fonts: z.array(z.string().max(80)).max(12) }),
})
export type CompanyBriefCard = z.infer<typeof companyBriefCardSchema>

export const companyBriefResultSchema = z.strictObject({
    brief: z.string().max(20_000),
    claims: z.array(companyBriefClaimSchema).max(40),
    unknowns: z.array(z.string().max(300)).max(40),
    card: companyBriefCardSchema,
})
export type CompanyBriefResult = z.infer<typeof companyBriefResultSchema>

export const COMPANY_BRIEF_ATTEMPT_STATUSES = ['pending', 'accepted', 'dismissed', 'cancelled', 'stopped', 'failed', 'handed', 'skipped', 'stale'] as const
export const companyBriefAttemptSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: foremanWorkspaceIdSchema,
    chatId: foremanChatIdSchema,
    discoveryId: z.string(),
    runId: z.string(),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    model: companyBriefModelSchema,
    status: z.enum(COMPANY_BRIEF_ATTEMPT_STATUSES),
    result: companyBriefResultSchema.nullable(),
    draft: z.string().max(20_000).nullable(),
    draftRevision: z.number().int().nonnegative(),
    error: z.strictObject({ code: z.string().min(1).max(80), message: z.string().max(500) }).nullable(),
})
export type CompanyBriefAttempt = z.infer<typeof companyBriefAttemptSchema>

export const companyBriefSynthesizeSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: foremanWorkspaceIdSchema,
    chatId: foremanChatIdSchema,
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    model: companyBriefModelSchema,
    snapshot: foremanDiscoveryRunSchema,
})
export type CompanyBriefSynthesizeInput = z.infer<typeof companyBriefSynthesizeSchema>

export const companyBriefObserveSchema = z.strictObject({
    workspaceId: foremanWorkspaceIdSchema,
    chatId: foremanChatIdSchema,
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    active: z.boolean(),
})

export const companyBriefCancelSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: foremanWorkspaceIdSchema,
    chatId: foremanChatIdSchema,
})

export const companyBriefEditSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: foremanWorkspaceIdSchema,
    chatId: foremanChatIdSchema,
    expectedDraftRevision: z.number().int().nonnegative(),
    brief: z.string().max(20_000),
})

export const companyBriefDismissSchema = companyBriefCancelSchema

export const companyBriefRetrySchema = companyBriefSynthesizeSchema.extend({
    previousRequestId: z.uuid(),
}).strict()

export const companyBriefHandoffSchema = z.strictObject({
    requestId: z.uuid(),
    handoffRequestId: z.uuid(),
    workspaceId: foremanWorkspaceIdSchema,
    chatId: foremanChatIdSchema,
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    selectedClaimIds: z.array(z.string().min(1).max(80)).min(1).max(40),
    includeDraft: z.boolean(),
    expectedPages: z.array(z.strictObject({
        slug: brainSlugSchema,
        expectedPageHash: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
    })).max(8),
})
export type CompanyBriefHandoffInput = z.infer<typeof companyBriefHandoffSchema>

export const companyBriefHandoffOutcomeSchema = z.strictObject({
    slug: z.string(),
    status: z.enum(['proposed', 'updated', 'duplicate', 'rejected']),
    proposalId: z.string().nullable(),
    code: z.string().nullable(),
})
export const companyBriefHandoffResultSchema = z.strictObject({
    handoffRequestId: z.uuid(),
    requestId: z.uuid(),
    status: z.enum(['recorded', 'rejected']),
    outcomes: z.array(companyBriefHandoffOutcomeSchema).max(8),
    recovered: z.boolean(),
})
export type CompanyBriefHandoffResult = z.infer<typeof companyBriefHandoffResultSchema>

// Same collector tags as apps/ui/lib/brain/seed-pages.ts. A markdown link or wikilink is not a source.
const SOURCE_TAG = /\[((?:dns|stack|site|search|registry|linkedin|google|catalog)(?::[\w.-]+)?(?:\s*[,;]\s*(?:dns|stack|site|search|registry|linkedin|google|catalog)(?::[\w.-]+)?)*)\](?!\()/g

export function companyBriefSourceTags(text: string): string[] {
    const tags = new Set<string>()
    for (const match of text.matchAll(SOURCE_TAG)) {
        for (const tag of match[1].split(/[,;]/)) {
            const trimmed = tag.trim()
            if (trimmed) tags.add(trimmed)
        }
    }
    return [...tags]
}

// `synthesis` is the brief itself, never evidence for a claim.
export function companyBriefSourceTag(finding: DesktopForemanFinding): string | null {
    switch (finding.source) {
        case 'linkedinPerson': return 'linkedin:person'
        case 'linkedinCompany': return 'linkedin:company'
        case 'googleBusiness': return 'google:business'
        case 'catalog': return 'catalog'
        case 'profile':
        case 'site': return finding.kind === 'products' ? 'site:catalog' : 'site'
        case 'search': return 'search'
        case 'registry': return 'registry'
        case 'dns': return 'dns'
        case 'stack': return 'stack'
        default: return null
    }
}

export type CompanyBriefEvidence = { tag: string; url: string }

export function companyBriefEvidence(snapshot: DesktopForemanDiscoveryRun): CompanyBriefEvidence[] {
    const seen = new Set<string>()
    const evidence: CompanyBriefEvidence[] = []
    for (const finding of snapshot.findings) {
        const tag = companyBriefSourceTag(finding)
        if (!tag) continue
        const key = `${tag}\n${finding.attribution.url}`
        if (seen.has(key)) continue
        seen.add(key)
        evidence.push({ tag, url: finding.attribution.url })
    }
    return evidence
}

function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

// UTF-8 SHA-256 of this string is the source revision. Computed beside the contract so the
// engine and the desktop server hash the same bytes.
export function companyBriefCanonicalSnapshot(snapshot: DesktopForemanDiscoveryRun): string {
    return stable(snapshot)
}
