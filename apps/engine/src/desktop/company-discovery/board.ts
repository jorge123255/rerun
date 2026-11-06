import { DESKTOP_COMPANY_DISCOVERY_LIMITS, type CompanyFinding, type CompanyDiscoveryAttribution, type CompanyDiscoverySource } from '@rerun/contracts'
import type { DnsFindings } from './parse.ts'
import { SOCIAL_NETWORKS, type SocialNetwork } from './parse.ts'

// How one collector adds to the board. Port of findingsForCollector for the collectors that can
// run locally. Icons stay null: the hosted services catalog is not on this computer.
// A mail provider is its own card. Frameworks are not tools. Identity keeps the first name.

const SOCIAL_LABELS: Record<SocialNetwork, string> = {
    linkedin: 'LinkedIn', instagram: 'Instagram', x: 'X', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', github: 'GitHub', pinterest: 'Pinterest', threads: 'Threads',
}
const NOT_TOOLS = new Set(['Framework'])

export type DiscoveryDraft = {
    identity: { name: string | null; oneLiner: string | null; logoUrl: string | null }
    tools: string[]
    networks: { name: string; audience: string | null }[]
}

export const emptyDraft = (): DiscoveryDraft => ({ identity: { name: null, oneLiner: null, logoUrl: null }, tools: [], networks: [] })

const clean = (value: string | null | undefined) => value?.trim() || null

function addTools(draft: DiscoveryDraft, names: string[]): boolean {
    const before = draft.tools.length
    for (const name of names.map(value => value.trim())) {
        if (draft.tools.length >= DESKTOP_COMPANY_DISCOVERY_LIMITS.maxTools) break
        if (name && !draft.tools.some(tool => tool.toLowerCase() === name.toLowerCase())) draft.tools.push(name)
    }
    return draft.tools.length > before
}

function addNetworks(draft: DiscoveryDraft, networks: { name: string; audience: string | null }[]): boolean {
    let changed = false
    for (const network of networks) {
        const id = SOCIAL_NETWORKS.find(known => known === network.name.trim().toLowerCase() || SOCIAL_LABELS[known].toLowerCase() === network.name.trim().toLowerCase())
        const name = id ? SOCIAL_LABELS[id] : network.name.trim()
        if (!name) continue
        const existing = draft.networks.find(known => known.name === name)
        if (!existing) {
            draft.networks.push({ name, audience: network.audience })
            changed = true
        } else if (network.audience && existing.audience !== network.audience) {
            existing.audience = network.audience
            changed = true
        }
    }
    return changed
}

function setIdentity(draft: DiscoveryDraft, patch: Partial<DiscoveryDraft['identity']>, keep: boolean): boolean {
    let changed = false
    for (const key of ['name', 'oneLiner', 'logoUrl'] as const) {
        const value = clean(patch[key])
        if (!value || draft.identity[key] === value || (keep && draft.identity[key])) continue
        draft.identity[key] = value
        changed = true
    }
    return changed
}

function cards(draft: DiscoveryDraft, source: CompanyDiscoverySource, domain: string, attribution: CompanyDiscoveryAttribution, changed: { identity?: boolean; tools?: boolean; networks?: boolean }): CompanyFinding[] {
    const { name, oneLiner, logoUrl } = draft.identity
    const findings: CompanyFinding[] = []
    if (changed.identity && name) findings.push({ kind: 'identity', source, attribution, name: name.slice(0, 200), oneLiner: oneLiner?.slice(0, 400) ?? null, logoUrl, domain })
    if (changed.tools && draft.tools.length) findings.push({ kind: 'tools', source, attribution, tools: draft.tools.map(tool => ({ name: tool.slice(0, 80), iconUrl: null })) })
    if (changed.networks && draft.networks.length) findings.push({ kind: 'social', source, attribution, networks: draft.networks.map(network => ({ name: network.name, iconUrl: null, audience: network.audience })) })
    return findings
}

export function findingsForDns(data: DnsFindings, draft: DiscoveryDraft, domain: string, attribution: CompanyDiscoveryAttribution): CompanyFinding[] {
    const tools = addTools(draft, data.services.map(service => service.name).filter(name => name !== data.mailProvider))
    const mail: CompanyFinding[] = data.mailProvider ? [{ kind: 'mail', source: 'dns', attribution, provider: data.mailProvider.slice(0, 80), iconUrl: null }] : []
    return [...mail, ...cards(draft, 'dns', domain, attribution, { tools })]
}

export function findingsForStack(input: { siteName: string | null; description: string | null; technologies: { name: string; category: string }[]; social: string[] }, draft: DiscoveryDraft, domain: string, attribution: CompanyDiscoveryAttribution): CompanyFinding[] {
    const tools = addTools(draft, input.technologies.filter(technology => !NOT_TOOLS.has(technology.category)).map(technology => technology.name))
    const networks = addNetworks(draft, input.social.map(name => ({ name, audience: null })))
    const identity = setIdentity(draft, { name: input.siteName, oneLiner: input.description }, true)
    return cards(draft, 'stack', domain, attribution, { identity, tools, networks })
}

export function findingsForSite(input: { social: string[]; colors: string[] }, draft: DiscoveryDraft, domain: string, attribution: CompanyDiscoveryAttribution): CompanyFinding[] {
    const networks = addNetworks(draft, input.social.map(name => ({ name, audience: null })))
    const brand: CompanyFinding[] = input.colors.length ? [{ kind: 'brand', source: 'site', attribution, colors: input.colors.slice(0, 5), fonts: [] }] : []
    return [...cards(draft, 'site', domain, attribution, { networks }), ...brand]
}

export function findingsForRegistry(input: { founded: string | null; headcount: string | null; city: string | null }, attribution: CompanyDiscoveryAttribution): CompanyFinding[] {
    if (!input.founded && !input.headcount && !input.city) return []
    return [{ kind: 'registry', source: 'registry', attribution, founded: input.founded, headcount: input.headcount, city: input.city }]
}
