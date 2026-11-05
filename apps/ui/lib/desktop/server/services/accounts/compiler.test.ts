import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { getMethod, serviceManifestSchema } from '@/lib/services/manifest'
import { parseServiceRegistryKey, serviceRegistryKey } from '@rerun/contracts'
import { accountMethodAvailability, additionalAccountVisible } from './availability'
import { CATALOG_CUSTOM_HEADER_REASON, compileAccountService } from './compiler'
import { isDisplayMask, nextAccountLabel, takenInstanceIds } from './identity'
import { anonymousManifest, bearerManifest, FIXTURE_TOKEN } from './regression-harness'
import { DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '../../../../../../../packages/contracts/src/desktop-service-accounts'

const target = { label: 'Fixture' }
const ok = { id: 'token', supported: true as const }

function custom(headers: Record<string, string>, inputs: Array<{ key: string; label: string; type?: string; secret?: boolean; required?: boolean }> = [{ key: 'TOKEN', label: 'Token', type: 'password', secret: true, required: true }], extra: Record<string, unknown> = {}) {
    return bearerManifest('fixture', {
        authMethods: [{
            id: 'token',
            label: 'API key',
            kind: 'key',
            recommended: true,
            inputs,
            envKeys: extra.envKeys ?? [],
            mcpServers: [{ name: 'fixture', transport: extra.transport ?? 'http', url: extra.url ?? 'https://example.com/mcp', headers, oauth: extra.oauth, command: extra.command, args: extra.args ?? [], env: extra.env ?? {} }],
        }],
        ...('skills' in extra ? { skills: extra.skills } : {}),
        ...('authMethods' in extra ? { authMethods: extra.authMethods } : {}),
    })
}

it('keeps original registry keys, six-character instance ids and ordinal labels', () => {
    expect(serviceRegistryKey('fixture')).toBe('fixture')
    expect(serviceRegistryKey('fixture', 'abc123')).toBe('fixture@abc123')
    expect(parseServiceRegistryKey('fixture@abc123')).toEqual({ slug: 'fixture', instanceId: 'abc123' })
    expect(parseServiceRegistryKey('fixture@ABC123')).toEqual({ slug: 'fixture@ABC123' })
    expect(parseServiceRegistryKey('fixture@ab')).toEqual({ slug: 'fixture@ab' })
    expect(nextAccountLabel('Fixture', [])).toBe('Fixture 2')
    expect(nextAccountLabel('Fixture', ['Fixture 2'])).toBe('Fixture 3')
    expect([...takenInstanceIds('fixture', ['fixture', 'fixture@abc123', 'other@abc123', 'fixture@NOPE'])]).toEqual(['abc123'])
    expect(isDisplayMask('••••')).toBe(true)
    expect(isDisplayMask('fixture-header-value')).toBe(false)
})

it('preserves anonymous and exact Bearer plans and keeps the fixture token out of the plan', () => {
    const anonymous = compileAccountService(anonymousManifest(), 'default', {}, { id: 'default', supported: true }, target)
    expect(anonymous.plan.shape).toBe('anonymous')
    expect(anonymous.bearer).toBe('')
    expect(anonymous.plan.key).toBe('fixture')
    const bearer = compileAccountService(bearerManifest(), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)
    expect(bearer.plan.shape).toBe('bearer')
    expect(bearer.bearer).toBe(FIXTURE_TOKEN)
    expect(bearer.headers.Authorization).toBe(`Bearer ${FIXTURE_TOKEN}`)
    expect(JSON.stringify(bearer.plan)).not.toContain(FIXTURE_TOKEN)
})

it('compiles fixed and input headers without putting secret or fixed values on the plan', () => {
    const compiled = compileAccountService(custom({ 'X-Region': 'fixture-region-marker', 'X-Api-Key': '${input.TOKEN}', 'X-Workspace': '${input.WORKSPACE}' }, [
        { key: 'WORKSPACE', label: 'Workspace', secret: false, required: true },
        { key: 'TOKEN', label: 'Token', type: 'password', secret: true, required: true },
    ]), 'token', { TOKEN: FIXTURE_TOKEN, WORKSPACE: 'acme' }, { id: 'token', supported: false, reason: CATALOG_CUSTOM_HEADER_REASON }, { label: 'Fixture', instanceId: 'abc123' })
    expect(compiled.plan.shape).toBe('headers')
    expect(compiled.bearer).toBe('')
    expect(compiled.plan.key).toBe('fixture@abc123')
    expect(compiled.plan.serverName).toBe('fixture-abc123')
    expect(compiled.plan.publicInputs).toEqual({ WORKSPACE: 'acme' })
    expect(compiled.plan.credentialInputs).toEqual(['TOKEN'])
    expect(compiled.plan.headerPlan.map(entry => entry.source)).toEqual(['fixed', 'input', 'input'])
    expect(JSON.stringify(compiled.plan)).not.toContain(FIXTURE_TOKEN)
    expect(JSON.stringify(compiled.plan)).not.toContain('fixture-region-marker')
    expect(compiled.headers['X-Api-Key']).toBe(FIXTURE_TOKEN)
})

it('refuses case collisions, injection, hop-by-hop headers, foreign substitution and unsupported methods', () => {
    const refuse = (manifest: ReturnType<typeof custom>, values: Record<string, string> = { TOKEN: FIXTURE_TOKEN }) => expect(() => compileAccountService(manifest, 'token', values, ok, target)).toThrow()
    refuse(custom({ Authorization: 'Bearer ${input.TOKEN}', authorization: 'second' }))
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.TOKEN}\r\nX-Evil: 1' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.headerValue)
    expect(() => compileAccountService(custom({ Host: '${input.TOKEN}' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.headerTransport)
    expect(() => compileAccountService(custom({ 'Transfer-Encoding': 'chunked' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.headerTransport)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${env.TOKEN}' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.substitution)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.MISSING}' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.missingInput)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.TOKEN}' }), 'token', { TOKEN: FIXTURE_TOKEN, EXTRA: 'nope' }, ok, target)).toThrow(M.unknownInput)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.TOKEN}' }, undefined, { url: 'https://example.com/mcp?${input.TOKEN}' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.endpoint)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.TOKEN}' }, undefined, { envKeys: [{ key: 'TOKEN', fromInput: 'TOKEN' }] }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.substitution)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.TOKEN}' }, undefined, { transport: 'sse' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.endpoint)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.TOKEN}' }, undefined, { command: 'remote' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.endpoint)
    expect(() => compileAccountService(custom({ 'X-Api-Key': '${input.TOKEN}' }, undefined, { url: 'https://rerun.build/api/hub' }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.hosted)
    expect(() => compileAccountService(custom({ 'X-Trace': 'fixed' }, [], { authMethods: [{ id: 'plain', label: 'Plain', kind: 'none', recommended: true, inputs: [], mcpServers: [{ name: 'fixture', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'fixed' } }] }] }), 'plain', {}, { id: 'plain', supported: true }, target)).toThrow(M.anonymous)
    expect(() => compileAccountService(custom({}, [{ key: 'TOKEN', label: 'Token', type: 'password', secret: true, required: true }], { skills: [{ name: 'Use', description: 'd', body: 'Use ${input.TOKEN}' }] }), 'token', { TOKEN: FIXTURE_TOKEN }, ok, target)).toThrow(M.skill)
})

it('does not fall back to another method and does not widen oauth or stdio', () => {
    const raw = bearerManifest('fixture', {
        authMethods: [
            bearerManifest().authMethods[0],
            { id: 'oauth', label: 'OAuth', kind: 'oauth', recommended: false, inputs: [], mcpServers: [{ name: 'fixture', transport: 'http', url: 'https://example.com/mcp', oauth: { scopes: ['read'] } }] },
            { id: 'local', label: 'Stdio', kind: 'stdio', recommended: false, inputs: [], mcpServers: [{ name: 'fixture', transport: 'stdio', command: 'tool' }] },
        ],
    })
    const parsed = serviceManifestSchema.parse(raw)
    expect(getMethod(parsed, 'missing').id).toBe('token')
    expect(() => compileAccountService(parsed, 'missing', {}, { id: 'missing', supported: true }, target)).toThrow(M.unknownMethod)
    expect(accountMethodAvailability(parsed, 'oauth').supported).toBe(false)
    expect(accountMethodAvailability(parsed, 'local').supported).toBe(false)
    expect(accountMethodAvailability(parsed, 'token').supported).toBe(true)
    expect(accountMethodAvailability(parsed, 'missing').reason).toBe(M.unknownMethod)
    expect(additionalAccountVisible({ multiInstance: true, installStatus: 'active', availability: [{ id: 'token', supported: true }] })).toBe(true)
    expect(additionalAccountVisible({ multiInstance: true, installStatus: 'needs_config', availability: [{ id: 'token', supported: true }] })).toBe(false)
    expect(additionalAccountVisible({ multiInstance: false, installStatus: 'active', availability: [{ id: 'token', supported: true }] })).toBe(false)
})
