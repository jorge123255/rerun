import { afterAll, expect, test, vi } from 'vitest'
import { serviceManifestSchema, type ServiceManifest } from '@/lib/services/manifest'
import {
    DESKTOP_SERVICE_HEALTH_UNCHECKED,
    desktopInstalledServiceSchema,
    desktopServiceCatalogPageSchema,
    desktopServiceDetailsSchema,
    desktopServiceMutationSchema,
} from '../../../../../../../packages/contracts/src/desktop-services.ts'
import bundledCatalog from './bundled-services.json'
import { DESKTOP_METHOD_REASONS, classifyDesktopServiceMethod } from './availability'

const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'))
const catalog = await import('./index')
afterAll(() => { fetchSpy.mockRestore() })

const FORBIDDEN_CLIENT_KEYS = ['mcpServers', 'envKeys', 'headers', 'oauth', 'composio', 'managed', 'clientSecret', 'authConfigId', 'embedding', 'command', 'args', 'env', 'health', 'connectUrl']

function collectKeys(value: unknown, found: Set<string>) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
        for (const item of value) collectKeys(item, found)
        return
    }
    for (const [key, nested] of Object.entries(value)) {
        found.add(key)
        collectKeys(nested, found)
    }
}

function policyManifest(extra: Record<string, unknown>): ServiceManifest {
    return serviceManifestSchema.parse({ slug: 'policy-fixture', name: 'Policy fixture', category: 'dev', summary: 'not a bundled service', ...extra })
}

function onlyMethod(manifest: ServiceManifest) {
    const method = manifest.authMethods[0]
    if (!method) throw new Error('policy fixture has no auth method')
    return method
}

test('loads the pinned seed without connecting services or calling the network', () => {
    expect(catalog.desktopServiceCatalogProvenance).toMatchObject({
        source: 'supabase/seed.sql',
        originalPin: 'a6d63a4b542674ddd002e51b39ba0df6e0807bcc',
        seedGitBlob: 'cc7201f8b16994132ee7698eb79c088891ada2b4',
        seedSha256: 'ebe7357ea24aa2788b93ce31d34f77a5dd067b349f4b9335d147579133257e33',
        catalogBase: '447fb9f03cd1113d50d199a1ec4c433198dc0ef9',
        count: 216,
    })
    expect(bundledCatalog.services).toHaveLength(216)
    expect(bundledCatalog.services.some(service => 'embedding' in service)).toBe(false)
    const page = catalog.listDesktopServiceCatalog({ limit: 500 })
    expect(page.total).toBe(209)
    expect(page.services).toHaveLength(209)
    expect(page.services.every(service => service.installed === false && service.installStatus === null && !('health' in service))).toBe(true)
    expect(page.services.flatMap(service => service.availability).filter(method => method.supported)).toHaveLength(50)
    expect(desktopServiceCatalogPageSchema.parse(page)).toEqual(page)
    expect(fetchSpy).not.toHaveBeenCalled()
})

test('microsoft is the anonymous Learn candidate and is not marked connected', () => {
    const record = catalog.getDesktopServiceManifest('microsoft')
    expect(record.manifest.mcpServers).toEqual([{ name: 'microsoft-learn', transport: 'http', url: 'https://learn.microsoft.com/api/mcp', args: [], env: {}, headers: {} }])
    expect(record.manifest.authMethods.map(method => method.id)).toEqual(['default'])
    expect(record.manifest.authMethods[0]?.kind).toBe('key')
    expect(record.details).toMatchObject({
        key: 'microsoft',
        slug: 'microsoft',
        name: 'Microsoft Learn',
        category: 'dev',
        icon: '/services/microsoft.png',
        verified: false,
        installed: false,
        installStatus: null,
        instances: [],
        multiInstance: false,
    })
    expect(record.details.authMethods[0]).toMatchObject({ id: 'default', requiresSecrets: false, inputs: [] })
    expect(record.details.availability).toEqual([{ id: 'default', supported: true }])
    expect(record.details.description.length).toBeGreaterThan(0)
    expect(record.details.description).toBe(record.manifest.description)
    expect(Object.isFrozen(record.manifest)).toBe(true)
    const keys = new Set<string>()
    collectKeys(record.details, keys)
    expect(FORBIDDEN_CLIENT_KEYS.some(key => keys.has(key))).toBe(false)
    expect(desktopServiceDetailsSchema.parse(record.details)).toEqual(record.details)
    expect(catalog.listDesktopServiceCatalog({ query: 'Microsoft Learn' }).services[0]?.slug).toBe('microsoft')
    expect(catalog.listDesktopServiceCatalog({ category: 'dev', query: 'microsoft' }).services.some(service => service.slug === 'microsoft')).toBe(true)
    expect(catalog.listDesktopServiceCatalog({ category: 'payments', query: 'microsoft' }).services).toHaveLength(0)
})

test('render bearer stays supported when its usage skill only mentions the header', () => {
    const record = catalog.getDesktopServiceManifest('render')
    expect(record.icon).toBe('/services/render.svg?tone=dark')
    expect(catalog.listDesktopServiceCatalog({ query: 'render', limit: 5 }).services[0]).toMatchObject({ slug: 'render', requiresSecrets: true, installed: false, verified: false })
    expect(catalog.getDesktopServiceMethodAvailability('render', 'default')).toEqual({ id: 'default', supported: true })
    const skill = record.manifest.skills[0]
    expect(skill?.name).toBe('render-usage')
    expect(skill?.body.includes('${')).toBe(false)
    expect(skill?.body.includes('Bearer')).toBe(true)
    expect(JSON.stringify(record.details)).not.toContain('The Render MCP server connects to your Render account to manage cloud infrastructure.')
    const input = record.details.authMethods[0]?.inputs[0]
    expect(input).toMatchObject({ key: 'RENDER_API_KEY', secret: true, type: 'password', required: true })
    expect(input && 'value' in input).toBe(false)
    record.details.authMethods[0]?.inputs.push({ key: 'LEAK', label: 'Leak', type: 'text', required: true, secret: true })
    expect(record.manifest.authMethods[0]?.inputs.map(item => item.key)).toEqual(['RENDER_API_KEY'])
})

test('unknown method ids fail and supported methods do not mark the sibling method connected', () => {
    expect(catalog.getDesktopServiceMethodAvailability('agentkey', 'oauth')).toEqual({ id: 'oauth', supported: false, reason: DESKTOP_METHOD_REASONS.oauth })
    expect(catalog.getDesktopServiceMethodAvailability('agentkey', 'pat')).toEqual({ id: 'pat', supported: true })
    expect(() => catalog.getDesktopServiceMethodAvailability('agentkey', 'default')).toThrow('Unknown auth method "default" for agentkey')
    expect(() => catalog.getDesktopServiceMethodAvailability('microsoft', 'oauth')).toThrow('Unknown auth method "oauth" for microsoft')
    expect(() => catalog.getDesktopServiceManifest('not-a-service')).toThrow('Service not found: not-a-service')
    expect(() => catalog.getDesktopServiceManifest('Microsoft')).toThrow('Service not found: Microsoft')
})

test('seed methods that are not one HTTPS bearer or anonymous server stay visible with reasons', () => {
    const reason = (slug: string, id: string) => catalog.getDesktopServiceMethodAvailability(slug, id).reason
    expect(reason('adobe', 'default')).toBe(DESKTOP_METHOD_REASONS.oauth)
    expect(reason('canva', 'composio')).toBe(DESKTOP_METHOD_REASONS.composio)
    expect(reason('facebook', 'managed')).toBe(DESKTOP_METHOD_REASONS.managed)
    expect(reason('apollo', 'api-key')).toBe(DESKTOP_METHOD_REASONS.stdio)
    expect(reason('wrike', 'permanent-access-token')).toBe(DESKTOP_METHOD_REASONS.sse)
    expect(reason('clay', 'default')).toBe(DESKTOP_METHOD_REASONS.serverCount)
    expect(reason('brightdata', 'default')).toBe(DESKTOP_METHOD_REASONS.secretUrl)
    expect(reason('unipile', 'default')).toBe(DESKTOP_METHOD_REASONS.url)
    expect(reason('posthog', 'api-key')).toBe(DESKTOP_METHOD_REASONS.env)
    expect(reason('agentmail', 'api-key')).toBe(DESKTOP_METHOD_REASONS.customHeader)
    expect(reason('atlassian', 'api-token')).toBe(DESKTOP_METHOD_REASONS.bearer)
    expect(catalog.getDesktopServiceMethodAvailability('github', 'oauth').supported).toBe(false)
    expect(catalog.getDesktopServiceMethodAvailability('github', 'api-key')).toEqual({ id: 'api-key', supported: true })
    expect(catalog.getDesktopServiceMethodAvailability('stripe', 'api-key')).toEqual({ id: 'api-key', supported: true })
    const listed = catalog.listDesktopServiceCatalog({ limit: 500 })
    const reasons = new Set(listed.services.flatMap(service => service.availability).flatMap(method => method.reason ?? []))
    for (const expected of [DESKTOP_METHOD_REASONS.oauth, DESKTOP_METHOD_REASONS.composio, DESKTOP_METHOD_REASONS.managed, DESKTOP_METHOD_REASONS.stdio, DESKTOP_METHOD_REASONS.sse, DESKTOP_METHOD_REASONS.serverCount, DESKTOP_METHOD_REASONS.secretUrl, DESKTOP_METHOD_REASONS.url, DESKTOP_METHOD_REASONS.env, DESKTOP_METHOD_REASONS.customHeader, DESKTOP_METHOD_REASONS.bearer]) {
        expect(reasons.has(expected)).toBe(true)
    }
    expect(listed.services.some(service => service.paidApp)).toBe(false)
})

test('shapes the seed does not contain still fail closed', () => {
    const omitted = policyManifest({ mcpServers: [{ name: 'example', url: 'https://example.com/mcp' }] })
    expect(classifyDesktopServiceMethod(omitted, onlyMethod(omitted))).toMatchObject({ supported: false, reason: DESKTOP_METHOD_REASONS.transport })
    const several = policyManifest({ mcpServers: [{ name: 'one', transport: 'http', url: 'https://example.com/one' }, { name: 'two', transport: 'http', url: 'https://example.com/two' }] })
    expect(classifyDesktopServiceMethod(several, onlyMethod(several))).toMatchObject({ supported: false, reason: DESKTOP_METHOD_REASONS.serverCount })
    const args = policyManifest({ mcpServers: [{ name: 'example', transport: 'http', url: 'https://example.com/mcp', args: ['--flag'] }] })
    expect(classifyDesktopServiceMethod(args, onlyMethod(args))).toMatchObject({ supported: false, reason: DESKTOP_METHOD_REASONS.args })
    const skill = policyManifest({ skills: [{ name: 'example-usage', body: 'Send ${input.TOKEN}' }], mcpServers: [{ name: 'example', transport: 'http', url: 'https://example.com/mcp' }] })
    expect(classifyDesktopServiceMethod(skill, onlyMethod(skill))).toMatchObject({ supported: false, reason: DESKTOP_METHOD_REASONS.skill })
    const app = policyManifest({ authMethods: [{ id: 'workspace', kind: 'app', app: { appSlug: 'example' }, mcpServers: [{ name: 'example', transport: 'http', url: 'https://example.com/mcp' }] }] })
    expect(classifyDesktopServiceMethod(app, onlyMethod(app))).toMatchObject({ id: 'workspace', supported: false, reason: DESKTOP_METHOD_REASONS.app })
    const emptyOAuth = policyManifest({ mcpServers: [{ name: 'example', transport: 'http', url: 'https://example.com/mcp', oauth: {} }] })
    expect(classifyDesktopServiceMethod(emptyOAuth, onlyMethod(emptyOAuth))).toMatchObject({ supported: false, reason: DESKTOP_METHOD_REASONS.oauth })
})

test('list pages the enabled library and keeps column search text', () => {
    expect(catalog.listDesktopServiceCatalog().services).toHaveLength(50)
    expect(catalog.listDesktopServiceCatalog({ query: '   ' }).total).toBe(209)
    const browse = catalog.listDesktopServiceCatalog({ limit: 500 })
    for (let index = 1; index < browse.services.length; index += 1) {
        const previous = browse.services[index - 1]
        const current = browse.services[index]
        if (!previous || !current) throw new Error('missing catalog page row')
        const order = previous.category.localeCompare(current.category, 'en') || previous.name.localeCompare(current.name, 'en') || previous.slug.localeCompare(current.slug, 'en')
        expect(order).toBeLessThanOrEqual(0)
    }
    expect(catalog.listDesktopServiceCatalog({ query: 'git', limit: 5 }).services[0]?.slug).toBe('github')
    expect(catalog.listDesktopServiceCatalog({ limit: 1, offset: 209 })).toEqual({ services: [], total: 209 })
    expect(() => catalog.listDesktopServiceCatalog({ category: 'nope' })).toThrow('Unknown service category: nope')
    expect(() => catalog.listDesktopServiceCatalog({ limit: 0 })).toThrow('Invalid catalog limit')
    expect(() => catalog.listDesktopServiceCatalog({ offset: -1 })).toThrow('Invalid catalog offset')
    const canva = catalog.getDesktopServiceManifest('canva')
    expect(catalog.listDesktopServiceCatalog({ query: 'Canva', limit: 1 }).services[0]?.summary).toBe('Create, edit, search, and export Canva designs and manage brand assets through natural language.')
    expect(canva.details.summary).toBe('Create, export and organize Canva designs, and autofill brand templates, straight from your agent.')
    expect(canva.details.installed).toBe(false)
})

test('disabled seed rows stay out of the catalog', () => {
    const disabled = bundledCatalog.services.filter(service => service.enabled === false).map(service => service.slug).sort()
    expect(disabled).toEqual(['dynamics-365', 'excel', 'linkedin', 'microsoft-teams', 'onedrive', 'sharepoint', 'vercel'])
    const listed = new Set(catalog.listDesktopServiceCatalog({ limit: 500 }).services.map(service => service.slug))
    for (const slug of disabled) {
        expect(listed.has(slug)).toBe(false)
        expect(() => catalog.getDesktopServiceManifest(slug)).toThrow(`Service not found: ${slug}`)
    }
})

test('desktop contracts keep secrets out of installed and mutation payloads', () => {
    const installed = {
        key: 'github',
        slug: 'github',
        name: 'GitHub',
        icon: '/services/github.svg?tone=dark',
        category: 'dev',
        status: 'active' as const,
        toolNames: [],
        installedAt: '2026-01-01T00:00:00.000Z',
        revision: 'rev-1',
        health: DESKTOP_SERVICE_HEALTH_UNCHECKED,
    }
    expect(desktopInstalledServiceSchema.parse(installed).health).toEqual({ state: 'unchecked' })
    expect(desktopInstalledServiceSchema.safeParse({ ...installed, clientSecret: 'secret' }).success).toBe(false)
    expect(desktopInstalledServiceSchema.safeParse({ ...installed, key: undefined }).success).toBe(false)
    expect(desktopServiceMutationSchema.safeParse({ action: 'install', requestId: 'req-1', slug: 'microsoft', authMethodId: 'default', values: {} }).success).toBe(true)
    expect(desktopServiceMutationSchema.safeParse({ action: 'install', requestId: 'req-1', slug: 'microsoft', authMethodId: 'default', values: {}, key: 'microsoft' }).success).toBe(false)
    expect(desktopServiceMutationSchema.safeParse({ action: 'probe', requestId: 'req-1', key: 'microsoft', expectedRevision: 'rev-1' }).success).toBe(true)
    expect(desktopServiceMutationSchema.safeParse({ action: 'disconnect', requestId: 'req-1', key: 'microsoft', expectedRevision: 'rev-1', revoked: true }).success).toBe(false)
})
