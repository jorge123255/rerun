import { expect, it } from 'vitest'
import { applyCompanyDiscoveryEvent, emptyCompanyDiscoverySnapshot } from '@rerun/contracts'
import { emptySkippedResult, groundCompanyBrief } from './ground.js'

const missingAudience = 'The sources did not say who the company sells to.'
const missingOffering = 'The sources did not list products or services.'
const missingCustomers = 'The sources did not name customers.'
const missingCompetitors = 'The sources did not name competitors.'

function siteSnapshot() {
    const url = 'https://acme.example/', fetchedAt = '2026-11-06T00:00:00.000Z'
    const initial = emptyCompanyDiscoverySnapshot({ workspaceId: '1', chatId: 'fmc_grounding0001', discoveryId: 'fmx_grounding0001', runId: 'run-grounding-1', url, domain: 'acme.example', startedAt: fetchedAt })
    const found = applyCompanyDiscoveryEvent(initial, {
        type: 'settled', source: 'site', revision: 1, status: 'found', reason: 'found', fetchedAt,
        provenance: [{ url, fetchedAt, via: 'public-fetch', status: 200 }],
        payload: { kind: 'site', site: { truncated: false, pages: [{ category: 'home', url, title: 'Acme', text: 'Acme offers scheduling software for small clinics.' }], productUrls: [], social: [], colors: [], fonts: [], failedPages: [] } },
        findings: [{ kind: 'identity', source: 'site', attribution: { url, fetchedAt, via: 'public-fetch' }, name: 'Acme', oneLiner: 'Scheduling software', logoUrl: null, domain: 'acme.example' }],
    }, fetchedAt)!
    return applyCompanyDiscoveryEvent(found, { type: 'end' }, fetchedAt)!
}

it('does not contradict accepted site-backed offering and audience sections with gaps inferred from missing cards', () => {
    const result = groundCompanyBrief(siteSnapshot(), {
        claims: [
            { section: 'Offering', text: 'Acme offers scheduling software.', sources: ['site'] },
            { section: 'Customers & market', text: 'Acme serves small clinics.', sources: ['site'] },
        ],
        unknowns: ['Pricing is not public.', 'The decision maker is not identified.'],
    })
    expect(result.claims).toHaveLength(2)
    expect(result.brief).toContain('Acme offers scheduling software. [site]')
    expect(result.brief).toContain('Acme serves small clinics. [site]')
    expect(result.unknowns).not.toContain(missingOffering)
    expect(result.unknowns).not.toContain(missingAudience)
    expect(result.brief).not.toContain(missingOffering)
    expect(result.brief).not.toContain(missingAudience)
    expect(result.unknowns).toContain(missingCustomers)
    expect(result.unknowns).toContain(missingCompetitors)
    expect(result.unknowns).toContain('Pricing is not public.')
    expect(result.unknowns).toContain('The decision maker is not identified.')
    expect(result.card.unknowns).toEqual(result.unknowns)
    // Claim acceptance does not invent structured product or named customer records.
    expect(result.card.offering.products).toEqual([])
    expect(result.card.market.notableCustomers).toEqual([])
})

it('keeps unanswered gaps when the only claims for those sections cite unavailable sources', () => {
    const result = groundCompanyBrief(siteSnapshot(), {
        claims: [
            { section: 'Offering', text: 'An unsupported product.', sources: ['search'] },
            { section: 'Customers & market', text: 'An unsupported audience.', sources: ['registry'] },
        ], unknowns: ['Pricing is not public.'],
    })
    expect(result.claims).toEqual([])
    expect(result.unknowns).toContain(missingOffering)
    expect(result.unknowns).toContain(missingAudience)
    expect(result.unknowns).toContain(missingCustomers)
    expect(result.unknowns).toContain(missingCompetitors)
    expect(result.unknowns).toContain('A claim cited a source the snapshot does not contain.')
    expect(result.unknowns).toContain('Pricing is not public.')
})

it('suppresses only the answered section and leaves skipped research without invented answers', () => {
    const snapshot = siteSnapshot()
    const result = groundCompanyBrief(snapshot, { claims: [{ section: 'Offering', text: 'Acme offers scheduling software.', sources: ['site'] }], unknowns: [] })
    expect(result.unknowns).not.toContain(missingOffering)
    expect(result.unknowns).toContain(missingAudience)
    expect(emptySkippedResult(snapshot).unknowns).toEqual(expect.arrayContaining([missingOffering, missingAudience, missingCustomers, missingCompetitors]))
})
