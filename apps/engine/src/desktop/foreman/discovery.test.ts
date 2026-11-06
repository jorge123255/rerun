import { applyForemanDiscoveryEvent, type DesktopForemanDiscoveryEvent, type DesktopForemanDiscoveryRun } from '@rerun/contracts'
import { expect, test } from 'vitest'
import { collectForemanDiscovery, identityFromPage } from './discovery.js'

const now = () => new Date('2026-11-05T12:00:00.000Z')
const run = (): DesktopForemanDiscoveryRun => ({ discoveryId: 'fmx_disc-0001', chat: { workspaceId: 'ws', chatId: 'fmc_chat-0001' }, runId: 'run-1', url: 'https://reloop.example/', status: 'running', pending: [], unavailable: [], findings: [] })

test('identity comes from the page itself and names the page it came from', () => {
    const finding = identityFromPage({ finalUrl: 'https://www.reloop.example/', html: '<title>Reloop | Returns made easy</title><meta name="description" content="Returns for shops">' }, now().toISOString())
    expect(finding).toMatchObject({ kind: 'identity', name: 'Reloop', oneLiner: 'Returns for shops', domain: 'reloop.example', attribution: { url: 'https://www.reloop.example/' } })
})

test('a page with nothing to read yields no finding', () => {
    expect(identityFromPage({ finalUrl: 'https://reloop.example/', html: '<div></div>' }, now().toISOString())).toBeNull()
})

test('unbacked collectors are unavailable and a failed read is dropped, never filled in', async () => {
    const events: DesktopForemanDiscoveryEvent[] = []
    await collectForemanDiscovery({ url: 'https://reloop.example/', signal: new AbortController().signal, emit: event => void events.push(event), read: async () => ({ ok: false, reason: 'blocked' }), now })
    const row = events.reduce(applyForemanDiscoveryEvent, run())
    expect(row.findings).toEqual([])
    expect(row.unavailable).toContain('linkedinCompany')
    expect(row.unavailable).not.toContain('site')
    expect(events).toContainEqual({ type: 'dropped', source: 'site', reason: 'blocked' })
})

test('the reducer ends pending sources and replaces a finding kind in place', () => {
    const attribution = { url: 'https://reloop.example/', fetchedAt: now().toISOString() }
    let row = applyForemanDiscoveryEvent(run(), { type: 'pending', source: 'site' })
    row = applyForemanDiscoveryEvent(row, { type: 'found', source: 'site', findings: [{ kind: 'audience', source: 'site', attribution, text: 'Shops' }] })
    row = applyForemanDiscoveryEvent(row, { type: 'found', source: 'site', findings: [{ kind: 'audience', source: 'site', attribution, text: 'Online shops' }] })
    row = applyForemanDiscoveryEvent(row, { type: 'end' })
    expect(row).toMatchObject({ status: 'done', pending: [], findings: [{ text: 'Online shops' }] })
})
