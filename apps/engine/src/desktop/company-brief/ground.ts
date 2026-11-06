import {
    COMPANY_BRIEF_NO_SOURCES,
    COMPANY_BRIEF_SECTION_PAGES,
    COMPANY_BRIEF_SECTIONS,
    companyBriefCardSchema,
    companyBriefEvidence,
    companyBriefSourceTag,
    companyBriefSourceTags,
    type BrainPageType,
    type CompanyBriefCard,
    type CompanyBriefClaim,
    type CompanyBriefResult,
    type CompanyBriefSection,
    type DesktopForemanDiscoveryRun,
} from '@rerun/contracts'

const MODEL_SECTIONS = COMPANY_BRIEF_SECTIONS.join(' | ')

// Original synthesis rules (apps/ui/lib/company/explore/synthesize.ts), pointed at the snapshot
// blocks instead of the hosted collectors.
export function companyBriefPrompt(snapshot: DesktopForemanDiscoveryRun): string {
    return [
        'You are building the company profile an AI assistant will rely on to work for this company and for the person who signed up.',
        `The website under review is ${snapshot.url}.`,
        'Below is everything the desktop explorers collected, one tagged block per source. Unavailable collectors are empty on purpose.',
        '',
        'Rules:',
        '- Only state what a source supports. Leave a field empty rather than guess, and list the gap in `unknowns`.',
        '- Sources can match a namesake: anything found via search, a registry entry matched by name where the person is not an officer, a LinkedIn page or Google place whose `matchesWebsite` is false. Check it against the website and the person; drop what does not fit, and say so in the brief.',
        '- Prefer the registry for legal facts, LinkedIn for headcount and people, the site for offering and pricing.',
        '- For an online shop, the catalog source lists its real products: name the main ones in offering.products and say it is e-commerce in businessModel.',
        '- Write the card and the brief in English, except proper names and quotes.',
        '- Every claim cites only tags that appear on the source blocks. Do not cite an unavailable source.',
        `- sections are exactly: ${COMPANY_BRIEF_SECTIONS.join(', ')}.`,
        '',
        'Return only a JSON object, no prose and no code fence:',
        `{"claims":[{"section":"${MODEL_SECTIONS}","text":"one fact, with no source tag inside it","sources":["tag"]}],"unknowns":["gap"]}`,
        '',
        sourceBlocks(snapshot),
    ].join('\n')
}

function sourceBlocks(snapshot: DesktopForemanDiscoveryRun): string {
    const blocks = snapshot.findings.flatMap(finding => {
        const tag = companyBriefSourceTag(finding)
        if (!tag) return []
        return [`<source tag="${tag}">\n${finding.attribution.url}\n${JSON.stringify(finding)}\n</source>`]
    })
    for (const source of snapshot.unavailable) {
        blocks.push(`<source tag="${source}" unavailable="true">\nThis collector is not available on desktop. Do not state facts from it.\n</source>`)
    }
    return blocks.join('\n\n')
}

export function cardFromSnapshot(snapshot: DesktopForemanDiscoveryRun, unknowns: string[]): CompanyBriefCard {
    const identity = snapshot.findings.find(finding => finding.kind === 'identity')
    const audience = snapshot.findings.flatMap(finding => finding.kind === 'audience' ? [finding.text] : [])
    const products = snapshot.findings.flatMap(finding => finding.kind === 'products' ? finding.items : [])
    const customers = snapshot.findings.flatMap(finding => finding.kind === 'customers' ? finding.items : [])
    const competitors = snapshot.findings.flatMap(finding => finding.kind === 'competitors' ? finding.items : [])
    return companyBriefCardSchema.parse({
        company: {
            name: identity?.kind === 'identity' ? identity.name : '',
            legalName: '',
            oneLiner: identity?.kind === 'identity' ? identity.oneLiner ?? '' : '',
            description: '', industry: '', founded: '', headcount: '', headquarters: '', siren: '',
        },
        person: { name: '', role: '', headline: '', location: '', linkedinUrl: '', background: '', photoUrl: null },
        offering: { products: unique(products).slice(0, 12), pricing: '', businessModel: '' },
        market: {
            audience: audience[0] ?? '',
            idealCustomer: '',
            notableCustomers: unique(customers).slice(0, 12),
            competitors: unique(competitors).slice(0, 12),
        },
        presence: { channels: [], reputation: '' },
        stack: [],
        voice: { tone: '', language: '' },
        unknowns: unknowns.slice(0, 40),
        branding: { logo: null, colors: [], fonts: [] },
    })
}

function unique(values: string[]): string[] {
    return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

export function gapsFor(snapshot: DesktopForemanDiscoveryRun): string[] {
    const kinds = new Set(snapshot.findings.map(finding => finding.kind))
    const gaps: string[] = []
    if (!kinds.has('identity')) gaps.push('The sources did not name the company.')
    if (!kinds.has('audience')) gaps.push('The sources did not say who the company sells to.')
    if (!kinds.has('products')) gaps.push('The sources did not list products or services.')
    if (!kinds.has('customers')) gaps.push('The sources did not name customers.')
    if (!kinds.has('competitors')) gaps.push('The sources did not name competitors.')
    gaps.push('The sources did not answer team, pricing, registry, stack, or reputation.')
    return gaps
}

type ModelClaim = { section: CompanyBriefSection; text: string; sources: string[] }

// Keeps a claim only when every cited tag is on the snapshot. Anything else becomes an unknown.
export function groundCompanyBrief(snapshot: DesktopForemanDiscoveryRun, model: { claims: ModelClaim[]; unknowns: string[] }): CompanyBriefResult {
    const evidence = companyBriefEvidence(snapshot)
    const allowed = new Set(evidence.map(item => item.tag))
    const claims: CompanyBriefClaim[] = []
    const unknowns = [...gapsFor(snapshot)]
    model.claims.forEach(claim => {
        const tagsInText = companyBriefSourceTags(claim.text)
        const sources = unique([...claim.sources, ...tagsInText])
        if (!sources.length || sources.some(tag => !allowed.has(tag)) || tagsInText.some(tag => !allowed.has(tag))) {
            unknowns.push('A claim cited a source the snapshot does not contain.')
            return
        }
        const text = withTags(claim.text, sources)
        const links = sources.flatMap(tag => {
            const url = evidence.find(item => item.tag === tag)?.url
            return url ? [{ tag, url }] : []
        })
        claims.push({ id: `c${claims.length + 1}`, section: claim.section, text, sources, links })
    })
    for (const unknown of model.unknowns) {
        if (!companyBriefSourceTags(unknown).length) unknowns.push(unknown.trim())
    }
    const brief = assembleBrief(claims, unique(unknowns))
    return { brief, claims, unknowns: unique(unknowns).slice(0, 40), card: cardFromSnapshot(snapshot, unique(unknowns)) }
}

function withTags(text: string, sources: string[]): string {
    const present = new Set(companyBriefSourceTags(text))
    const missing = sources.filter(tag => !present.has(tag))
    const body = text.replace(/\s+$/, '')
    return missing.length ? `${body} ${missing.map(tag => `[${tag}]`).join(' ')}` : body
}

export function assembleBrief(claims: CompanyBriefClaim[], unknowns: string[]): string {
    const parts: string[] = []
    for (const section of COMPANY_BRIEF_SECTIONS) {
        if (section === 'Open questions') continue
        const rows = claims.filter(claim => claim.section === section)
        if (rows.length) parts.push(`## ${section}\n\n${rows.map(claim => claim.text).join('\n\n')}`)
    }
    const questions = [...claims.filter(claim => claim.section === 'Open questions').map(claim => claim.text), ...unknowns.map(item => `- ${item}`)]
    if (questions.length) parts.push(`## Open questions\n\n${questions.join('\n\n')}`)
    return parts.join('\n\n')
}

export function emptySkippedResult(snapshot: DesktopForemanDiscoveryRun): CompanyBriefResult {
    const unknowns = [COMPANY_BRIEF_NO_SOURCES, ...gapsFor(snapshot)]
    return { brief: `## Open questions\n\n${unknowns.map(item => `- ${item}`).join('\n\n')}`, claims: [], unknowns: unique(unknowns).slice(0, 40), card: cardFromSnapshot(snapshot, unknowns) }
}

export type CompanyBriefPagePlan = {
    slug: string
    title: string
    type: BrainPageType
    content: string
    sources: string[]
    headline: string
    highlights: { label: string; before: null; after: string }[]
}

export function planCompanyBriefPages(input: {
    result: CompanyBriefResult
    draft: string | null
    draftRevision: number
    includeDraft: boolean
    selectedClaimIds: string[]
    allowedTags: Set<string>
}): { ok: true; pages: CompanyBriefPagePlan[] } | { ok: false; code: 'draft_not_included' | 'ungrounded_draft' | 'nothing_selected' } {
    const selected = input.result.claims.filter(claim => input.selectedClaimIds.includes(claim.id))
    if (!selected.length) return { ok: false, code: 'nothing_selected' }
    const draftDiffers = input.draft !== null && input.draft !== input.result.brief
    if ((draftDiffers || input.draftRevision > 0) && !input.includeDraft) return { ok: false, code: 'draft_not_included' }
    if (input.includeDraft) {
        const draft = input.draft ?? input.result.brief
        const tags = companyBriefSourceTags(draft)
        if (!draft.trim() || !tags.length || tags.some(tag => !input.allowedTags.has(tag))) return { ok: false, code: 'ungrounded_draft' }
    }
    const bySlug = new Map<string, CompanyBriefClaim[]>()
    for (const claim of selected) {
        const page = COMPANY_BRIEF_SECTION_PAGES[claim.section]
        const list = bySlug.get(page.slug) ?? []
        list.push(claim)
        bySlug.set(page.slug, list)
    }
    const identityName = input.result.card.company.name.trim()
    const pages: CompanyBriefPagePlan[] = []
    for (const [slug, claims] of bySlug) {
        const sample = claims[0]
        if (!sample) continue
        const meta = COMPANY_BRIEF_SECTION_PAGES[sample.section]
        const title = slug === 'company' && identityName ? identityName.slice(0, 120) : meta.title
        const body = claims.map(claim => claim.text).join('\n\n')
        const content = slug === 'company' && input.includeDraft
            ? (input.draft ?? input.result.brief).trim()
            : slug === 'open-questions'
                ? `## To confirm with the team\n\nThe research could not answer these. Confirm them and update the matching page.\n\n${body}`
                : `## ${meta.title}\n\n${body}`
        const sources = unique(claims.flatMap(claim => [...claim.sources, ...claim.links.map(link => link.url)])).slice(0, 20)
        const highlights = claims.slice(0, 4).map(claim => ({
            label: claim.section.slice(0, 40),
            before: null,
            after: claim.text.replace(/\s+/g, ' ').slice(0, 80) || title.slice(0, 80),
        }))
        if (content.length > 60_000) return { ok: false, code: 'ungrounded_draft' }
        pages.push({
            slug, title, type: meta.type, content, sources,
            headline: (sample.text.replace(/\s+/g, ' ').slice(0, 60) || title).slice(0, 60),
            highlights,
        })
    }
    return { ok: true, pages }
}
