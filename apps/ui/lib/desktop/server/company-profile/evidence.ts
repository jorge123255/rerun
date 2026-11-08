import {
    DESKTOP_COMPANY_PROFILE_LIMITS,
    type CompanyDiscoverySource,
    type CompanyPayload,
    type CompanyProvenance,
    type DesktopCompanyDiscoverySnapshot,
    type DesktopCompanyProfileEvidence,
} from '@rerun/contracts'

export function companyProfileEvidenceFromPayload(
    source: CompanyDiscoverySource,
    payload: CompanyPayload,
    provenance: CompanyProvenance[],
): DesktopCompanyProfileEvidence[] {
    const origin = provenance[0]
    if (!origin) return []
    const rows: Omit<DesktopCompanyProfileEvidence, 'url' | 'fetchedAt' | 'via' | 'status'>[] = []
    if (payload.kind === 'stack' && source === 'stack') {
        if (payload.stack.meta.siteName?.trim()) rows.push({ id: 'stack:name', field: 'name', source, passage: payload.stack.meta.siteName.trim() })
        if (payload.stack.meta.description?.trim()) rows.push({ id: 'stack:description', field: 'description', source, passage: payload.stack.meta.description.trim() })
        if (payload.stack.meta.title?.trim()) rows.push({ id: 'stack:title', field: 'other', source, passage: payload.stack.meta.title.trim() })
    }
    if (payload.kind === 'site' && source === 'site') {
        for (const [index, page] of payload.site.pages.entries()) {
            if (page.text?.trim()) rows.push({ id: `site:page:${index}`, field: 'other', source, passage: page.text.trim() })
        }
    }
    if (payload.kind === 'catalog' && source === 'catalog') {
        for (const [index, product] of payload.catalog.products.entries()) {
            if (product.name.trim()) rows.push({ id: `catalog:product:${index}`, field: 'offering', source, passage: product.name.trim() })
        }
    }
    if (payload.kind === 'registry' && source === 'registry' && payload.registry.company?.name.trim()) {
        rows.push({ id: 'registry:name', field: 'name', source, passage: payload.registry.company.name.trim() })
    }
    if (payload.kind === 'dns' && source === 'dns') {
        for (const [index, service] of payload.dns.services.entries()) {
            if (service.evidence.trim()) rows.push({ id: `dns:service:${index}`, field: 'other', source, passage: service.evidence.trim() })
        }
    }
    return rows.map(row => ({
        ...row,
        passage: row.passage.slice(0, DESKTOP_COMPANY_PROFILE_LIMITS.maxEvidencePassageChars),
        url: origin.url,
        fetchedAt: origin.fetchedAt,
        via: origin.via,
        status: origin.status,
    })).filter(row => row.passage.length > 0)
}

export function companyProfileEvidenceFromDiscovery(snapshot: DesktopCompanyDiscoverySnapshot): DesktopCompanyProfileEvidence[] {
    return snapshot.sources.flatMap(source => source.status === 'found'
        ? companyProfileEvidenceFromPayload(source.source, source.payload, source.provenance)
        : []).slice(0, DESKTOP_COMPANY_PROFILE_LIMITS.maxEvidence)
}
