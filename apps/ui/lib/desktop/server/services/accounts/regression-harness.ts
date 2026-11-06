import { serviceManifestSchema, type ServiceManifest } from '@/lib/services/manifest'
import { accountLifecycle, type AccountLifecycleDeps, type AccountSkillPort } from './lifecycle'
import { canonical, memoryInstalls } from './installs'
import { memoryHeaderSecrets } from './secret-store'
import { memoryReservations } from './reservations'
import { accountTransport, type AccountNetwork } from './transport'

export const FIXTURE_TOKEN = 'fixture-header-value'
export const FIXTURE_URL = 'https://example.com/mcp'

export function rfcUuid(n: number): string {
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

export function anonymousManifest(slug = 'fixture', extra: Record<string, unknown> = {}): ServiceManifest {
    return serviceManifestSchema.parse({
        slug,
        name: 'Fixture',
        category: 'dev',
        summary: 'Summary',
        description: 'Description',
        multiInstance: false,
        skills: [],
        authMethods: [{ id: 'default', label: 'Default', kind: 'none', recommended: true, inputs: [], mcpServers: [{ name: 'fixture', transport: 'http', url: FIXTURE_URL }] }],
        ...extra,
    })
}

export function bearerManifest(slug = 'fixture', extra: Record<string, unknown> = {}): ServiceManifest {
    return serviceManifestSchema.parse({
        slug,
        name: 'Fixture',
        category: 'dev',
        summary: 'Summary',
        description: 'Description',
        multiInstance: true,
        skills: [],
        authMethods: [{
            id: 'token',
            label: 'API key',
            kind: 'key',
            recommended: true,
            inputs: [{ key: 'TOKEN', label: 'Token', type: 'password', secret: true, required: true }],
            mcpServers: [{ name: 'fixture', transport: 'http', url: FIXTURE_URL, headers: { Authorization: 'Bearer ${input.TOKEN}' } }],
        }],
        ...extra,
    })
}

export async function mcpResponse(_url: string, init: RequestInit): Promise<Response> {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    const body = JSON.parse(String(init.body)) as { id?: number; method: string }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } } }, { headers: { 'mcp-session-id': 'sess-1' } })
    if (body.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } })
    const headers = new Headers(init.headers)
    const secret = headers.get('authorization') ?? headers.get('x-api-key') ?? ''
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `saw ${secret}` }] } })
}

export function accountHarness() {
    const installs = memoryInstalls()
    const secrets = memoryHeaderSecrets()
    const reservations = memoryReservations()
    const manifests: Record<string, ServiceManifest> = {}
    const networkCalls: Array<{ url: string; init: RequestInit }> = []
    const removedSkills: string[] = []
    let engine = 'engine-1'
    let granted = false
    let enabled = true
    let now = '2026-01-01T00:00:00.000Z'
    let uuidN = 0
    let skillReferences = 0
    let responder: AccountNetwork = mcpResponse
    const skills: AccountSkillPort = {
        async create(_root, installationId, index) {
            const slug = `svc-${installationId.replaceAll('-', '').slice(0, 16)}-${index}`
            return { slug, directoryIdentity: `dir:${slug}`, contentHash: 'fixture-content-hash', manifestVersion: '1' }
        },
        async verify() {},
        async remove(_root, owned) {
            removedSkills.push(owned.slug)
        },
        async referencedInstallations() {
            return skillReferences
        },
    }
    const deps: AccountLifecycleDeps = {
        installs,
        secrets,
        reservations,
        catalog: { manifest: async slug => manifests[slug] ?? null },
        authority: { current: async () => ({ engineAgentId: engine, enabled, granted, skillsRoot: '/skills', launchNonce: 'launch-1' }) },
        transport: accountTransport(async (url, init) => {
            networkCalls.push({ url, init })
            return responder(url, init)
        }),
        ids: { uuid: () => rfcUuid(++uuidN), instanceId: taken => (taken.has('abc123') ? 'def456' : 'abc123') },
        clock: { now: () => now },
        skills,
    }
    let requestN = 8000
    return {
        deps,
        installs,
        secrets,
        reservations,
        manifests,
        networkCalls,
        removedSkills,
        canonical,
        skills,
        binding: { coworkerId: 'coworker-1', engineOwnerId: 'engine-1' } as const,
        requestId: () => rfcUuid(++requestN),
        signal: () => new AbortController().signal,
        setEngine: (value: string) => { engine = value },
        setGranted: (value: boolean) => { granted = value },
        setEnabled: (value: boolean) => { enabled = value },
        setNow: (value: string) => { now = value },
        setSkillReferences: (value: number) => { skillReferences = value },
        setResponder: (next: AccountNetwork) => { responder = next },
        lifecycle: () => accountLifecycle(deps),
    }
}
