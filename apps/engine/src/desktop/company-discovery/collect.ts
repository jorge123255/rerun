import {
    COMPANY_DISCOVERY_CREDENTIALED_SOURCES,
    DESKTOP_COMPANY_DISCOVERY_LIMITS,
    companyDiscoveryEventSchema,
    readCompanyDiscoveryTarget,
    type CompanyDiscoveryEvent,
    type CompanyDiscoverySource,
    type CompanyFinding,
    type CompanyPayload,
    type CompanyProvenance,
} from '@rerun/contracts'
import { emptyDraft, findingsForDns, findingsForRegistry, findingsForSite, findingsForStack } from './board.js'
import { detectTechnologies, findSiren, hrefsOf, htmlToText, pickPages, productUrlsOf, readDnsRecords, readPageMeta, readProductPage, readRegistryCompany, readShopifyProducts, readWooProducts, sliceHtml, socialProfiles } from './parse.js'
import type { DnsLookup, PublicPageReader, PublicRead } from './ports.js'

export type CompanyCollectorInput = {
    url: string
    signal: AbortSignal
    now: () => Date
    revisions: Partial<Record<CompanyDiscoverySource, number>>
    read: PublicPageReader
    dns: DnsLookup
    emit: (event: CompanyDiscoveryEvent) => void
}

// Free local collectors, in the original dependency order. Paid search, LinkedIn, Google and the
// LLM synthesis are marked unavailable. Stop stops new admissions; the caller awaits this promise
// so work already admitted can settle.
export async function runCompanyCollectors(input: CompanyCollectorInput): Promise<void> {
    const revisions: Partial<Record<CompanyDiscoverySource, number>> = { ...input.revisions }
    const pending = new Set<CompanyDiscoverySource>()
    const draft = emptyDraft()
    const reads = new Map<string, Promise<PublicRead>>()
    const read = (url: string, accept: 'html' | 'json') => {
        const key = `${accept} ${url}`
        const existing = reads.get(key)
        if (existing) return existing
        const pendingRead = input.read(url, input.signal, accept)
        reads.set(key, pendingRead)
        return pendingRead
    }
    const peek = (source: CompanyDiscoverySource) => (revisions[source] ?? 0) + 1
    const publish = (event: CompanyDiscoveryEvent) => {
        const parsed = companyDiscoveryEventSchema.parse(event)
        if (parsed.type === 'pending') pending.add(parsed.source)
        if (parsed.type === 'settled') {
            revisions[parsed.source] = parsed.revision
            pending.delete(parsed.source)
        }
        input.emit(parsed)
    }
    const at = () => input.now().toISOString()
    const fail = (source: CompanyDiscoverySource, reason: 'failed' | 'timeout' | 'blocked' | 'malformed' | 'oversized' | 'private' | 'cancelled' | 'empty' | 'not-a-shop' | 'no-siren', provenance: CompanyProvenance[] = []) => {
        const omitted = reason === 'empty' || reason === 'not-a-shop' || reason === 'no-siren'
        publish({ type: 'settled', source, revision: peek(source), status: omitted ? 'omitted' : 'failed', reason, fetchedAt: at(), provenance, payload: { kind: 'none' }, findings: [] })
    }

    try {
        for (const source of COMPANY_DISCOVERY_CREDENTIALED_SOURCES) publish({ type: 'unavailable', source, reason: 'credentialed' })
        publish({ type: 'unavailable', source: 'profile', reason: 'welcome-card' })
        if (input.signal.aborted) return
        const target = readCompanyDiscoveryTarget(input.url)
        for (const source of ['dns', 'stack', 'site'] as const) publish({ type: 'pending', source })
        const [dns, home] = await Promise.all([input.dns(target.domain, input.signal), read(target.url, 'html')])
        const dnsProvenance: CompanyProvenance[] = [{ url: `dns://${target.domain}`, fetchedAt: at(), via: 'public-dns', status: null }]
        if (!dns.ok) fail('dns', dns.reason, dnsProvenance)
        else {
            const data = readDnsRecords(dns.records)
            const attribution = { url: target.url, fetchedAt: at(), via: 'public-dns' as const }
            const findings = findingsForDns(data, draft, target.domain, attribution)
            publish({
                type: 'settled', source: 'dns', revision: peek('dns'), status: findings.length ? 'found' : 'omitted', reason: findings.length ? 'found' : 'empty',
                fetchedAt: attribution.fetchedAt, provenance: dnsProvenance,
                payload: { kind: 'dns', dns: { mailProvider: data.mailProvider, mx: data.mx.map(host => host.slice(0, 253)), services: data.services.map(service => ({ name: service.name.slice(0, 80), evidence: service.evidence.slice(0, 160) })), spfIncludes: data.spfIncludes.map(include => include.slice(0, 253)), dmarcPolicy: data.dmarcPolicy } },
                findings,
            })
        }
        if (!home.ok) {
            fail('stack', home.reason, [{ url: target.url, fetchedAt: at(), via: 'public-fetch', status: null }])
            fail('site', home.reason, [{ url: target.url, fetchedAt: at(), via: 'public-fetch', status: null }])
        } else await settlePages(input, target, home, read, publish, peek, draft, fail, at)
        if (!input.signal.aborted) await settleCatalog(input, target, read, publish, peek, fail, at)
    } finally {
        for (const source of pending) fail(source, input.signal.aborted ? 'cancelled' : 'failed')
        if (!input.signal.aborted) publish({ type: 'end' })
    }
}

async function settlePages(
    input: CompanyCollectorInput,
    target: { url: string; domain: string },
    home: Extract<PublicRead, { ok: true }>,
    read: (url: string, accept: 'html' | 'json') => Promise<PublicRead>,
    publish: (event: CompanyDiscoveryEvent) => void,
    next: (source: CompanyDiscoverySource) => number,
    draft: ReturnType<typeof emptyDraft>,
    fail: (source: CompanyDiscoverySource, reason: 'failed' | 'timeout' | 'blocked' | 'malformed' | 'oversized' | 'private' | 'cancelled' | 'empty' | 'not-a-shop' | 'no-siren', provenance?: CompanyProvenance[]) => void,
    at: () => string,
) {
    const sliced = sliceHtml(home.body)
    const meta = readPageMeta(sliced.html)
    const links = hrefsOf(sliced.html, home.url)
    const social = Object.keys(socialProfiles(links))
    const technologies = detectTechnologies(sliced.html)
    const fetchedAt = at()
    const attribution = { url: home.url, fetchedAt, via: 'public-fetch' as const }
    const stackFindings = findingsForStack({ siteName: meta.siteName, description: meta.description, technologies, social }, draft, target.domain, attribution)
    publish({
        type: 'settled', source: 'stack', revision: next('stack'), status: stackFindings.length ? 'found' : 'omitted', reason: stackFindings.length ? 'found' : 'empty',
        fetchedAt, provenance: [{ url: home.url, fetchedAt, via: 'public-fetch', status: home.status }],
        payload: { kind: 'stack', stack: { finalUrl: home.url, truncated: sliced.truncated, technologies, meta: { title: meta.title, description: meta.description, siteName: meta.siteName }, social } },
        findings: stackFindings,
    })

    const pages = input.signal.aborted ? [] : pickPages(links, home.url)
    const extras: { category: string; url: string; title: string | null; text: string; reason?: string }[] = []
    const provenance: CompanyProvenance[] = [{ url: home.url, fetchedAt, via: 'public-fetch', status: home.status }]
    let truncated = sliced.truncated
    const texts = [htmlToText(sliced.html)]
    for (let index = 0; index < pages.length; index += DESKTOP_COMPANY_DISCOVERY_LIMITS.maxConcurrent) {
        if (input.signal.aborted) break
        const batch = pages.slice(index, index + DESKTOP_COMPANY_DISCOVERY_LIMITS.maxConcurrent)
        const reads = await Promise.all(batch.map(async page => ({ page, result: await read(page.url, 'html') })))
        for (const { page, result } of reads) {
            if (!result.ok) {
                extras.push({ category: page.category, url: page.url, title: null, text: '', reason: result.reason })
                continue
            }
            const body = sliceHtml(result.body)
            truncated = truncated || body.truncated
            const pageMeta = readPageMeta(body.html)
            texts.push(htmlToText(body.html))
            extras.push({ category: page.category, url: result.url, title: pageMeta.title, text: texts[texts.length - 1] })
            if (provenance.length < DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProvenance) provenance.push({ url: result.url, fetchedAt: at(), via: 'public-fetch', status: result.status })
        }
    }
    const colors = meta.themeColor ? [meta.themeColor] : []
    const siteSocial = Object.keys(socialProfiles([...links, ...extras.flatMap(page => page.url ? [page.url] : [])]))
    const siteFindings = findingsForSite({ social: siteSocial, colors }, draft, target.domain, attribution)
    publish({
        type: 'settled', source: 'site', revision: next('site'), status: siteFindings.length || extras.length ? 'found' : 'omitted', reason: siteFindings.length || extras.length ? 'found' : 'empty',
        fetchedAt, provenance,
        payload: {
            kind: 'site',
            site: {
                truncated,
                pages: [{ category: 'home', url: home.url, title: meta.title }, ...extras.filter(page => !page.reason).map(page => ({ category: page.category, url: page.url, title: page.title }))].slice(0, 8),
                productUrls: productUrlsOf(links, home.url),
                social: siteSocial,
                colors,
                fonts: [],
                failedPages: extras.filter(page => page.reason).map(page => ({ url: page.url, reason: page.reason ?? 'failed' })),
            },
        },
        findings: siteFindings,
    })

    if (input.signal.aborted) return
    publish({ type: 'pending', source: 'registry' })
    const ordered = [...extras].sort((a, b) => Number(b.category === 'legal') - Number(a.category === 'legal'))
    const siren = [htmlToText(sliced.html), ...ordered.map(page => page.text)].map(findSiren).find(Boolean) ?? null
    if (!siren) {
        fail('registry', 'no-siren')
        return
    }
    const registryUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(siren)}&per_page=5`
    const response = await read(registryUrl, 'json')
    const registryProvenance: CompanyProvenance[] = [{ url: registryUrl, fetchedAt: at(), via: 'public-registry', status: response.ok ? response.status : null }]
    if (!response.ok) {
        fail('registry', response.reason, registryProvenance)
        return
    }
    let parsed: unknown
    try { parsed = JSON.parse(response.body) } catch {
        fail('registry', 'malformed', registryProvenance)
        return
    }
    const results = parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results) ? (parsed as { results: Record<string, unknown>[] }).results : null
    if (!results) {
        fail('registry', 'malformed', registryProvenance)
        return
    }
    const company = results.map(result => readRegistryCompany(result, siren)).find(Boolean) ?? null
    if (!company?.name) {
        publish({ type: 'settled', source: 'registry', revision: next('registry'), status: 'omitted', reason: 'empty', fetchedAt: at(), provenance: registryProvenance, payload: { kind: 'registry', registry: { matchedBy: 'siren', query: siren, company: null } }, findings: [] })
        return
    }
    const registryAttribution = { url: registryUrl, fetchedAt: at(), via: 'public-registry' as const }
    const findings = findingsForRegistry({ founded: company.founded, headcount: company.headcount, city: company.city }, registryAttribution)
    publish({
        type: 'settled', source: 'registry', revision: next('registry'), status: findings.length ? 'found' : 'omitted', reason: findings.length ? 'found' : 'empty',
        fetchedAt: registryAttribution.fetchedAt, provenance: registryProvenance,
        payload: { kind: 'registry', registry: { matchedBy: 'siren', query: siren, company } },
        findings,
    })
}

async function settleCatalog(
    input: CompanyCollectorInput,
    target: { url: string; domain: string },
    read: (url: string, accept: 'html' | 'json') => Promise<PublicRead>,
    publish: (event: CompanyDiscoveryEvent) => void,
    next: (source: CompanyDiscoverySource) => number,
    fail: (source: CompanyDiscoverySource, reason: 'failed' | 'timeout' | 'blocked' | 'malformed' | 'oversized' | 'private' | 'cancelled' | 'empty' | 'not-a-shop' | 'no-siren', provenance?: CompanyProvenance[]) => void,
    at: () => string,
) {
    publish({ type: 'pending', source: 'catalog' })
    if (input.signal.aborted) return
    const home = await read(target.url, 'html')
    if (!home.ok) {
        fail('catalog', home.reason)
        return
    }
    const sliced = sliceHtml(home.body)
    const technologies = detectTechnologies(sliced.html)
    const platform = technologies.find(technology => technology.category === 'E-commerce')?.name ?? null
    const productUrls = productUrlsOf(hrefsOf(sliced.html, home.url), home.url)
    const shopUrl = new URL(home.url).origin
    if (!platform && productUrls.length < 3) {
        fail('catalog', 'not-a-shop')
        return
    }
    const provenance: CompanyProvenance[] = []
    let products: { name: string; url: string }[] = []
    let total: number | null = null
    let lower = false
    if (platform === 'Shopify' || platform === 'WooCommerce') {
        const endpoint = platform === 'Shopify'
            ? new URL('/products.json?limit=50&page=1', shopUrl).toString()
            : new URL('/wp-json/wc/store/v1/products?per_page=50', shopUrl).toString()
        const response = await read(endpoint, 'json')
        provenance.push({ url: endpoint, fetchedAt: at(), via: 'bundled-catalog', status: response.ok ? response.status : null })
        if (!response.ok) {
            fail('catalog', response.reason, provenance)
            return
        }
        let body: unknown
        try { body = JSON.parse(response.body) } catch {
            fail('catalog', 'malformed', provenance)
            return
        }
        if (platform === 'Shopify') {
            const parsed = readShopifyProducts(body, shopUrl)
            if (!parsed) {
                fail('catalog', 'malformed', provenance)
                return
            }
            products = parsed
            total = parsed.length
            lower = parsed.length === 50
        } else {
            const parsed = readWooProducts(body, shopUrl)
            if (!parsed) {
                fail('catalog', 'malformed', provenance)
                return
            }
            products = parsed.products
            total = parsed.total
        }
    } else {
        const pages = productUrls.slice(0, DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProductReads)
        for (let index = 0; index < pages.length && !input.signal.aborted; index += DESKTOP_COMPANY_DISCOVERY_LIMITS.maxConcurrent) {
            const batch = pages.slice(index, index + DESKTOP_COMPANY_DISCOVERY_LIMITS.maxConcurrent)
            const reads = await Promise.all(batch.map(async url => ({ url, result: await read(url, 'html') })))
            for (const { url, result } of reads) {
                if (!result.ok) continue
                if (provenance.length < DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProvenance) provenance.push({ url: result.url, fetchedAt: at(), via: 'bundled-catalog', status: result.status })
                const product = readProductPage(sliceHtml(result.body).html, url)
                if (product) products.push(product)
            }
        }
        total = products.length
    }
    const payload: CompanyPayload = { kind: 'catalog', catalog: { platform, shopUrl, total, totalIsLowerBound: lower, collections: [], products: products.slice(0, DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProducts) } }
    if (!products.length) {
        publish({ type: 'settled', source: 'catalog', revision: next('catalog'), status: 'omitted', reason: 'empty', fetchedAt: at(), provenance, payload, findings: [] })
        return
    }
    // Product cards on the original board come from synthesis, which this lane does not run.
    publish({ type: 'settled', source: 'catalog', revision: next('catalog'), status: 'found', reason: 'found', fetchedAt: at(), provenance, payload, findings: [] as CompanyFinding[] })
}
