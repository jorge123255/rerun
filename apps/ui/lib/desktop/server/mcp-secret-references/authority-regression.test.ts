import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { desktopMcpSecretReferenceCanonical, redactDesktopMcpSecretValue, type DesktopMcpSecretReferenceConfig } from '@rerun/contracts'
import { createDesktopMcpSecretLookup } from './lookup'
import { withDesktopMcpSecrets } from './resolve'

const config: DesktopMcpSecretReferenceConfig = { name: 'server', transport: 'http', url: 'https://example.test/mcp', args: [], headers: { Authorization: 'Bearer ${TOKEN}' }, env: {}, oauth: false, literalAuthorization: false, preservedLiteralKeys: [] }
const binding = { agentId: 'owner', serverName: 'server', configRevision: 'canonical-uuid', bindingRevision: 1, field: 'header' as const, fieldKey: 'Authorization', secretName: 'TOKEN', secretVersion: 1, status: 'bound' as const, origin: 'workspace' }
const head = { configRevision: binding.configRevision, bindingRevision: 1, origin: binding.origin, fingerprint: createHash('sha256').update(desktopMcpSecretReferenceCanonical(config)).digest('hex') }
const owner = { agentId: 'owner', enabled: true, deleting: false, selfMcpGranted: true, localMcpStdioGranted: true }

test('a rotated opener cannot substitute newer credential bytes after an older version read', async () => {
    const consume = vi.fn(async () => 'result')
    const lookup = createDesktopMcpSecretLookup({ execute: vi.fn(async () => ({ rows: [{ version: 1 }] })) } as never, {
        async useCredential(agentId, key, gate, invoke) { await gate.check({ agentId, key, version: 2 }); return invoke(new TextEncoder().encode('new-secret')) },
    })
    expect(await lookup.open('owner', 'TOKEN', 1, { check: () => {} }, consume)).toEqual({ state: 'rotated', version: 2 })
    expect(consume).not.toHaveBeenCalled()
})

test('revoke while opening a secret prevents the transport callback', async () => {
    let enabled = true
    const use = vi.fn(async () => 'connected')
    const lookup = createDesktopMcpSecretLookup({ execute: vi.fn(async () => ({ rows: [{ version: 1 }] })) } as never, {
        async useCredential(agentId, key, gate, consume) { await gate.check({ agentId, key, version: 1 }); enabled = false; await gate.check({ agentId, key, version: 1 }); return consume(new TextEncoder().encode('secret')) },
    })
    const result = await withDesktopMcpSecrets({ agentId: 'owner', serverName: 'server', phase: 'invocation', transport: 'http', config, bindings: [binding], head, check: async () => {}, authority: { currentOwner: async () => ({ ...owner, enabled }) }, lookup, use })
    expect(result.ok).toBe(false)
    expect(use).not.toHaveBeenCalled()
})

test('another canonical revision or changed public configuration cannot reuse a bound secret', async () => {
    const use = vi.fn(async () => 'connected'), lookup = { version: vi.fn(), open: vi.fn() }
    for (const change of [{ ...config, url: 'https://other.test/mcp' }, config]) {
        const result = await withDesktopMcpSecrets({ agentId: 'owner', serverName: 'server', phase: 'invocation', transport: 'http', config: change, bindings: [{ ...binding, configRevision: 'new-revision' }], head, check: async () => {}, authority: { currentOwner: async () => owner }, lookup, use })
        expect(result.ok).toBe(false)
    }
    expect(lookup.open).not.toHaveBeenCalled(); expect(use).not.toHaveBeenCalled()
})

test('aliases, cycles and short values never return the original secret object', () => {
    const shared = { value: 'xy' }, cyclic: Record<string, unknown> = { shared }; cyclic.self = cyclic
    const result = redactDesktopMcpSecretValue([shared, shared, cyclic], [new TextEncoder().encode('xy')])
    expect(result[0]).not.toBe(shared); expect(result[1]).toBe(result[0])
    expect(JSON.stringify(result)).not.toContain('xy')
    expect(result[2]).toMatchObject({ self: '[redacted cycle]' })
})
