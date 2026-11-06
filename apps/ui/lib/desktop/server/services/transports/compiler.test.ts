import { describe, expect, it } from 'vitest'
import { serviceManifestSchema } from '@/lib/services/manifest'
import { compileServiceTransport, parseTemplate, serviceTransportMethods } from './compiler'
import { resolveTransportMaterial } from './resolve'
import type { TransportAuthority } from './types'
const ref = { agentId: 'coworker', key: 'example', installationId: '00000000-0000-4000-8000-000000000001', revision: '00000000-0000-4000-8000-000000000002' }
const raw = { slug: 'example', name: 'Example', inputs: [{ key: 'TOKEN', type: 'password', label: 'API key', secret: true, required: true }], mcpServers: [{ name: 'example', transport: 'sse', url: 'https://example.org/sse', headers: { Authorization: 'Bearer ${input.TOKEN}' } }] }
const manifest = () => serviceManifestSchema.parse(raw)
const authority = (plan = compileServiceTransport(manifest(), 'default', ref)): TransportAuthority => ({ ref, plan, methodId: plan.methodId, configurationGeneration: 'configuration', credentialGeneration: 'credential', engineOwnerId: 'engine', enabled: true, appsGranted: true, remoteGranted: true, programGranted: true, check() {} })
const programs = { resolve: async () => null, validateExecutable: async () => '', validateArguments: async () => {} }
describe('declarative service transport compiler', () => {
    it('preserves references and never needs credentials to classify a method', () => {
        const plan = compileServiceTransport(manifest(), 'default', ref)
        expect(plan.bearer).toEqual([{ input: 'TOKEN' }])
        expect(serviceTransportMethods(manifest(), ref)[0].availability).toBe('supported')
        expect(() => compileServiceTransport(manifest(), 'unknown', ref)).toThrow()
    })
    it('uses account keys and immutable installations, not labels', () => {
        const m = serviceManifestSchema.parse({ ...raw, multiInstance: true })
        expect(compileServiceTransport(m, 'default', { ...ref, key: 'example@abc123' }).serverName).toBe('example-abc123')
        expect(() => compileServiceTransport(m, 'default', { ...ref, key: 'other@abc123' })).toThrow()
    })
    it('refuses unknown/nested/hosted placeholders, custom headers and secret URLs', () => {
        for (const value of ['${agent.id}', '${RERUN_API_KEY}', '${input.MISSING}', '${input.${TOKEN}}']) expect(() => parseTemplate(value, manifest().inputs)).toThrow()
        for (const server of [{ url: 'https://example.org/${input.TOKEN}' }, { url: 'https://example.org/sse?token=literal' }, { url: 'https://user:pass@example.org/sse' }, { headers: { 'X-API-Key': '${input.TOKEN}' } }, { url: 'https://mcp.rerun.build/sse' }]) {
            const m = serviceManifestSchema.parse({ ...raw, mcpServers: [{ ...raw.mcpServers[0], ...server }] })
            expect(() => compileServiceTransport(m, 'default', ref)).toThrow()
        }
    })
    it('unseals only at execution and keeps secret values out of plans', async () => {
        let reads = 0
        const a = authority(), material = await resolveTransportMaterial(a, { read: async () => { reads++; return { kind: 'secret', reference: 'opaque' } }, unseal: async () => 'private-value' }, programs, async () => {}, new AbortController().signal)
        expect(material).toEqual({ transport: 'sse', url: 'https://example.org/sse', bearer: 'private-value' })
        expect(reads).toBe(1); expect(JSON.stringify(a.plan)).not.toContain('private-value')
    })
    it('rejects changed secret classifications and CRLF credentials', async () => {
        for (const read of [async () => ({ kind: 'public' as const, value: 'private-value' }), async () => ({ kind: 'secret' as const, reference: 'opaque' })]) {
            await expect(resolveTransportMaterial(authority(), { read, unseal: async () => 'value\r\nInjected: yes' }, programs, async () => {}, new AbortController().signal)).rejects.toThrow()
        }
    })
    it('never starts or installs a missing package and refuses secret argv', async () => {
        const m = serviceManifestSchema.parse({ ...raw, mcpServers: [{ name: 'example', transport: 'stdio', command: 'npx', args: ['-y', 'example', '${input.TOKEN}'] }] })
        const a = authority(compileServiceTransport(m, 'default', ref))
        const values = { read: async () => ({ kind: 'secret' as const, reference: 'opaque' }), unseal: async () => { throw Error('must not unseal argv') } }
        await expect(resolveTransportMaterial(a, values, programs, async () => {}, new AbortController().signal)).rejects.toThrow('unavailable')
        await expect(resolveTransportMaterial(a, values, { ...programs, resolve: async () => ({ executable: '/usr/local/bin/example', args: a.plan.args, supportsEnvironment: false }) }, async () => {}, new AbortController().signal)).rejects.toThrow('unsupported')
    })
    it('refuses environment injection and package runners even after a malicious binding', async () => {
        const m = serviceManifestSchema.parse({ ...raw, mcpServers: [{ name: 'example', transport: 'stdio', command: 'npx', env: { NODE_OPTIONS: '${input.TOKEN}' } }] })
        expect(() => compileServiceTransport(m, 'default', ref)).toThrow()
        const p = compileServiceTransport(serviceManifestSchema.parse({ ...raw, mcpServers: [{ name: 'example', transport: 'stdio', command: 'npx' }] }), 'default', ref)
        await expect(resolveTransportMaterial(authority(p), { read: async () => null, unseal: async () => '' }, { ...programs, resolve: async () => ({ executable: '/usr/bin/npx', args: [], supportsEnvironment: false }) }, async () => {}, new AbortController().signal)).rejects.toThrow()
    })
})

it('does not silently drop SSE OAuth declarations or catalog overrides', () => {
    for (const oauth of [{}, { clientId: 'fixed-client' }, { scopes: ['write'] }, { authorizationServer: 'https://auth.example.org' }]) {
        const m = serviceManifestSchema.parse({ ...raw, mcpServers: [{ ...raw.mcpServers[0], oauth }] })
        expect(() => compileServiceTransport(m, 'default', ref)).toThrow('unsupported')
        expect(serviceTransportMethods(m, ref)[0].availability).toBe('unsupported')
    }
})
