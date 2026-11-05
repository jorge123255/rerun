import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { accountFeature } from './feature'
import { accountHarness, bearerManifest, FIXTURE_TOKEN, rfcUuid } from './regression-harness'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '../../../../../../../packages/contracts/src/desktop-service-accounts'

function featureFor() {
    const h = accountHarness()
    h.manifests.fixture = bearerManifest()
    const feature = accountFeature({
        ...h.deps,
        agent: async coworkerId => (coworkerId === h.binding.coworkerId ? { id: coworkerId, engineAgentId: 'engine-1' } : null),
        catalog: {
            manifest: h.deps.catalog.manifest,
            async page() {
                return {
                    total: 1,
                    services: [{ slug: 'fixture', name: 'Fixture', category: 'dev', summary: 'Summary', icon: null, verified: true, manifest: h.manifests.fixture }],
                }
            },
        },
    })
    return { h, feature }
}

it('reads installed accounts without probing or accepting engine authority from the body', async () => {
    const { h, feature } = featureFor()
    const installed = await feature.handle(new Request('http://desktop.local/service-accounts?view=installed'), h.binding.coworkerId)
    expect(installed.status).toBe(200)
    expect(installed.headers.get('cache-control')).toBe('no-store')
    expect(await installed.json()).toEqual([])
    expect(h.networkCalls).toHaveLength(0)
    const secretBody = { engineOwnerId: 'engine-9', url: 'https://evil.example/mcp', headers: { Authorization: FIXTURE_TOKEN }, action: 'install', requestId: rfcUuid(3), intent: { kind: 'new', slug: 'fixture' }, authMethodId: 'token', values: { TOKEN: FIXTURE_TOKEN } }
    const rejected = await feature.handle(new Request('http://desktop.local/service-accounts', { method: 'POST', body: JSON.stringify(secretBody) }), h.binding.coworkerId)
    const rejectedText = await rejected.text()
    expect(rejected.status).toBe(400)
    expect(rejectedText).not.toContain(FIXTURE_TOKEN)
    expect(rejectedText).not.toContain('evil.example')
    const malformed = await feature.handle(new Request('http://desktop.local/service-accounts', { method: 'POST', body: JSON.stringify({ action: 'install', requestId: rfcUuid(4), intent: { kind: 'new', slug: 'fixture' }, authMethodId: 'token', values: { TOKEN: FIXTURE_TOKEN }, note: 'extra' }) }), h.binding.coworkerId)
    const malformedText = await malformed.text()
    expect(malformedText).not.toContain(FIXTURE_TOKEN)
    expect(malformedText).toContain('acknowledgement is unknown')
    const missing = await feature.handle(new Request('http://desktop.local/service-accounts?view=installed'), 'missing-coworker')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: M.unknownService })
})

it('installs through the feature handler once and hides the credential from the catalog row', async () => {
    const { h, feature } = featureFor()
    const body = { action: 'install', requestId: rfcUuid(5), intent: { kind: 'new', slug: 'fixture' }, authMethodId: 'token', values: { TOKEN: FIXTURE_TOKEN } }
    const first = await feature.handle(new Request('http://desktop.local/service-accounts', { method: 'POST', body: JSON.stringify(body) }), h.binding.coworkerId)
    const saved = await first.json()
    const second = await feature.handle(new Request('http://desktop.local/service-accounts', { method: 'POST', body: JSON.stringify(body) }), h.binding.coworkerId)
    const replay = await second.json()
    expect(replay.installationId).toBe(saved.installationId)
    expect(JSON.stringify(replay)).not.toContain(FIXTURE_TOKEN)
    expect(h.networkCalls).toHaveLength(0)
    const catalog = await feature.handle(new Request('http://desktop.local/service-accounts?view=catalog'), h.binding.coworkerId)
    const page = await catalog.json()
    expect(page.services[0].addAccount).toBe(false)
    expect(page.services[0].multiInstance).toBe(true)
    expect(JSON.stringify(page)).not.toContain(FIXTURE_TOKEN)
    expect(JSON.stringify(page)).not.toContain('Bearer ${input.TOKEN}')
})
