import { expect, it, vi } from 'vitest'
import type { ExternalMcpCallContext, ExternalMcpPrincipal } from '@rerun/contracts'

const principal: ExternalMcpPrincipal = {
    version: 1,
    keyId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 1,
    keyRevision: 2,
    scopes: ['mcp:read', 'coworkers:write', 'schedules:write', 'triggers:write', 'connectors:write', 'runs:send', 'data:write'],
    installId: '22222222-2222-4222-8222-222222222222',
    launchNonce: '33333333-3333-4333-8333-333333333333',
    runtimeWorkspaceId: 1,
    expiresAt: null,
}

function ctx(tool: string, args: Record<string, unknown> = {}): ExternalMcpCallContext {
    return {
        version: 1,
        principal,
        requestId: '55555555-5555-4555-8555-555555555555',
        fingerprint: 'b'.repeat(64),
        tool,
        arguments: args,
    }
}

it('requireConfirm and string helpers refuse closed without mutating', async () => {
    const { requireConfirm, requireString, asString } = await import('./guard')
    expect(() => requireConfirm({}, 'delete')).toThrow(/confirm/)
    expect(() => requireConfirm({ confirm: false }, 'delete')).toThrow(/confirm/)
    expect(() => requireConfirm({ confirm: true }, 'delete')).not.toThrow()
    expect(() => requireString('', 'agentId')).toThrow(/agentId/)
    expect(asString(1)).toBeUndefined()
    expect(requireString('ok', 'agentId')).toBe('ok')
})

it('connector mutations fail closed when services authority is missing', async () => {
    vi.resetModules()
    vi.doMock('../runtime', () => ({
        readDesktopRuntime: async () => ({
            protocolVersion: 1,
            launchNonce: principal.launchNonce,
            buildId: 'build',
            workspaceId: 1,
            dataRoot: '/tmp/not-used',
            app: { origin: 'http://127.0.0.1:9/', sessionToken: 'x'.repeat(32) },
            engine: { origin: 'http://127.0.0.1:9/', apiKey: 'key' },
        }),
    }))
    vi.doMock('../database', () => ({ openDesktopDatabase: async () => ({ execute: async () => ({ rows: [] }) }) }))
    vi.doMock('../store', () => ({
        findDesktopAgent: async () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceId: 1, engineAgentId: 'eng', name: 'A', description: '', enabled: true }),
        listDesktopAgents: async () => [],
    }))
    const { invokeExternalMcpOperation } = await import('./operations')
    const recheck = async () => ({ ok: true as const, principal })
    await expect(invokeExternalMcpOperation(ctx('attach_connector', { agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'gmail' }), new AbortController().signal, { recheck })).rejects.toThrow(/service authority/)
})

it('services-bound attach requires authMethodId and uses the B request id', async () => {
    vi.resetModules()
    vi.doMock('../runtime', () => ({
        readDesktopRuntime: async () => ({
            protocolVersion: 1,
            launchNonce: principal.launchNonce,
            buildId: 'build',
            workspaceId: 1,
            dataRoot: '/tmp/not-used',
            app: { origin: 'http://127.0.0.1:9/', sessionToken: 'x'.repeat(32) },
            engine: { origin: 'http://127.0.0.1:9/', apiKey: 'key' },
        }),
    }))
    vi.doMock('../database', () => ({ openDesktopDatabase: async () => ({ execute: async () => ({ rows: [] }) }) }))
    vi.doMock('../store', () => ({
        findDesktopAgent: async () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceId: 1, engineAgentId: 'eng', name: 'A', description: '', enabled: true }),
        listDesktopAgents: async () => [],
    }))
    const mutate = vi.fn(async (_owner: string, input: Record<string, unknown>) => input)
    const { invokeExternalMcpOperation } = await import('./operations')
    const recheck = async () => ({ ok: true as const, principal })
    await expect(invokeExternalMcpOperation(ctx('attach_connector', { agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'gmail' }), new AbortController().signal, {
        recheck,
        services: { listInstalled: async () => [], mutate },
    })).rejects.toThrow(/authMethodId/)
    await invokeExternalMcpOperation(ctx('attach_connector', {
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        slug: 'gmail',
        authMethodId: 'none',
        values: {},
    }), new AbortController().signal, { recheck, services: { listInstalled: async () => [], mutate } })
    expect(mutate).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expect.objectContaining({
        action: 'install',
        requestId: '55555555-5555-4555-8555-555555555555',
        slug: 'gmail',
        authMethodId: 'none',
    }), expect.any(AbortSignal))
})
