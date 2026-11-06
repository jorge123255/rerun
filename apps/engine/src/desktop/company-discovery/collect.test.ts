import { applyCompanyDiscoveryEvent, emptyCompanyDiscoverySnapshot, type CompanyDiscoveryEvent } from '@rerun/contracts'
import { expect, test } from 'vitest'
import { runCompanyCollectors } from './collect.js'
import { readDnsRecords } from './parse.js'
import type { DnsLookup, PublicPageReader } from './ports.js'

const now = () => new Date('2026-11-05T12:00:00.000Z')
const url = 'https://acme.example/'
const home = '<html><head><title>Acme | Home</title><meta property="og:site_name" content="Acme"><meta name="description" content="Kettles"></head><body><a href="https://www.linkedin.com/company/acme">Acme</a></body></html>'

function snapshot() {
    return emptyCompanyDiscoverySnapshot({ discoveryId: 'fmx_disc-0001', workspaceId: 'ws-1', chatId: 'fmc_chat-0001', runId: 'run-1', url, domain: 'acme.example', startedAt: now().toISOString() })
}

function fold(events: CompanyDiscoveryEvent[]) {
    return events.reduce((state, event) => applyCompanyDiscoveryEvent(state, event, now().toISOString()) ?? state, snapshot())
}

const dns: DnsLookup = async () => ({ ok: true, records: { mx: ['aspmx.l.google.com'], txt: ['google-site-verification=secret-token', 'v=spf1 include:_spf.google.com -all'], dmarc: ['v=DMARC1; p=reject'] } })

test('dns keeps the service name and drops the verification token', () => {
    const findings = readDnsRecords({ mx: ['aspmx.l.google.com'], txt: ['google-site-verification=secret-token'], dmarc: [] })
    expect(findings.mailProvider).toBe('Google Workspace')
    expect(findings.services.map(service => service.name)).toContain('Google Search Console')
    expect(JSON.stringify(findings)).not.toContain('secret-token')
})

test('source identity, provenance and a repeated revision do not duplicate the card', async () => {
    const events: CompanyDiscoveryEvent[] = []
    await runCompanyCollectors({ url, signal: new AbortController().signal, now, revisions: {}, dns, read: async (target) => ({ ok: true, url: target, status: 200, contentType: 'text/html', body: home, bytes: home.length }), emit: event => events.push(event) })
    const row = fold(events)
    const mail = row.findings.find(finding => finding.kind === 'mail')
    const identity = row.findings.find(finding => finding.kind === 'identity')
    expect(mail).toMatchObject({ source: 'dns', provider: 'Google Workspace', attribution: { via: 'public-dns' } })
    expect(identity).toMatchObject({ source: 'stack', name: 'Acme', domain: 'acme.example' })
    expect(JSON.stringify(row)).not.toContain('secret-token')
    expect(row.unavailable).toEqual(expect.arrayContaining(['search', 'linkedinCompany', 'googleBusiness', 'synthesis', 'profile']))
    const again = applyCompanyDiscoveryEvent(row, events.find(event => event.type === 'settled' && event.source === 'dns')!, now().toISOString())
    expect(again).toBeNull()
    expect(row.sources.find(source => source.source === 'dns')?.revision).toBe(1)
})

test('stop drains the admitted page and does not start the shop catalog', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const read: PublicPageReader = async target => {
        calls.push(target)
        controller.abort()
        await gate
        return { ok: true, url: target, status: 200, contentType: 'text/html', body: home, bytes: home.length }
    }
    const events: CompanyDiscoveryEvent[] = []
    const pending = runCompanyCollectors({ url, signal: controller.signal, now, revisions: {}, dns, read, emit: event => events.push(event) })
    await Promise.resolve()
    release()
    await pending
    expect(calls).toEqual([url])
    expect(events.some(event => event.type === 'settled' && event.source === 'stack' && event.status === 'found')).toBe(true)
    expect(events.some(event => event.type === 'pending' && event.source === 'catalog')).toBe(false)
    expect(events.some(event => event.type === 'end')).toBe(false)
})

test('an oversized page fails the site and keeps the dns card', async () => {
    const events: CompanyDiscoveryEvent[] = []
    await runCompanyCollectors({
        url, signal: new AbortController().signal, now, revisions: {}, dns,
        read: async () => ({ ok: false, reason: 'oversized' }),
        emit: event => events.push(event),
    })
    const row = fold(events)
    expect(row.findings.map(finding => finding.kind)).toContain('mail')
    expect(row.sources.find(source => source.source === 'stack')).toMatchObject({ status: 'failed', reason: 'oversized' })
    expect(row.sources.find(source => source.source === 'site')).toMatchObject({ status: 'failed', reason: 'oversized' })
})

test('a malformed registry reply does not remove the pages already read', async () => {
    const legal = `${home}<p>SIREN 552 100 554</p>`
    const events: CompanyDiscoveryEvent[] = []
    const calls: string[] = []
    await runCompanyCollectors({
        url, signal: new AbortController().signal, now, revisions: {}, dns,
        read: async target => {
            calls.push(target)
            if (target.includes('recherche-entreprises')) return { ok: true, url: target, status: 200, contentType: 'application/json', body: '{', bytes: 1 }
            return { ok: true, url: target, status: 200, contentType: 'text/html', body: legal, bytes: legal.length }
        },
        emit: event => events.push(event),
    })
    const row = fold(events)
    expect(calls.some(call => call.includes('recherche-entreprises'))).toBe(true)
    expect(row.sources.find(source => source.source === 'registry')).toMatchObject({ status: 'failed', reason: 'malformed' })
    expect(row.findings.some(finding => finding.kind === 'identity' && finding.source === 'stack')).toBe(true)
})

test('a private address is refused before any read', async () => {
    const calls: string[] = []
    await expect(runCompanyCollectors({
        url: 'https://127.0.0.1/secret', signal: new AbortController().signal, now, revisions: {}, dns,
        read: async target => { calls.push(target); return { ok: false, reason: 'failed' } },
        emit: () => {},
    })).rejects.toThrow('private_target')
    expect(calls).toEqual([])
})

test('the bundled shop catalog records product names and does not invent a synthesis card', async () => {
    const shop = '<html><head><title>Acme</title><meta property="og:site_name" content="Acme"></head><script src="https://cdn.shopify.com/s.js"></script></html>'
    const events: CompanyDiscoveryEvent[] = []
    await runCompanyCollectors({
        url, signal: new AbortController().signal, now, revisions: {}, dns: async () => ({ ok: true, records: { mx: [], txt: [], dmarc: [] } }),
        read: async target => target.includes('products.json')
            ? { ok: true, url: target, status: 200, contentType: 'application/json', body: JSON.stringify({ products: [{ title: 'Kettle', handle: 'kettle' }] }), bytes: 40 }
            : { ok: true, url: target, status: 200, contentType: 'text/html', body: shop, bytes: shop.length },
        emit: event => events.push(event),
    })
    const row = fold(events)
    const catalog = row.sources.find(source => source.source === 'catalog')
    expect(catalog?.payload).toMatchObject({ kind: 'catalog', catalog: { platform: 'Shopify', products: [{ name: 'Kettle' }] } })
    expect(row.findings.some(finding => finding.kind === 'products')).toBe(false)
    expect(row.findings.some(finding => finding.kind === 'tools' && finding.tools.some(tool => tool.name === 'Shopify'))).toBe(true)
})
