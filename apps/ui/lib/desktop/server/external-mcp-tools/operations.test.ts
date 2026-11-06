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

it('read-only trigger projections retain instructions but never reveal a capability URL or secret fields', async () => {
    const { externalMcpTriggerSummary } = await import('./operations')
    expect(externalMcpTriggerSummary({ slug: 'report', name: 'Report', body: 'Make the report.', methods: ['POST'], enabled: true, token: 'private-token', url: 'http://127.0.0.1/private-token', headers: { authorization: 'private' }, credentials: { value: 'private' } })).toEqual({ slug: 'report', name: 'Report', body: 'Make the report.', methods: ['POST'], enabled: true })
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


it('assertExternalMcpAgentMetadataOnlyUpdate allows name/description/soul/handle/verbosity/Box fields', async () => {
    const { assertExternalMcpAgentMetadataOnlyUpdate } = await import('./operations')
    expect(() => assertExternalMcpAgentMetadataOnlyUpdate({
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Renamed',
        description: 'd',
        soul: 's',
        handle: 'h',
        verbosity: 'normal',
        spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        connectionId: 'conn',
        model: 'm',
        provider: 'p',
    })).not.toThrow()
})

it('assertExternalMcpAgentMetadataOnlyUpdate denies each authority-bearing field and mixed metadata+grant', async () => {
    const { assertExternalMcpAgentMetadataOnlyUpdate, EXTERNAL_MCP_AGENT_AUTHORITY_FIELDS } = await import('./operations')
    for (const key of EXTERNAL_MCP_AGENT_AUTHORITY_FIELDS) {
        expect(() => assertExternalMcpAgentMetadataOnlyUpdate({ agentId: 'a', name: 'ok', [key]: key === 'tools' ? { desktopToolGrants: { browser: true } } : {} })).toThrow(/no changes were applied/)
        expect(() => assertExternalMcpAgentMetadataOnlyUpdate({ agentId: 'a', name: 'ok', [key]: key === 'tools' ? { desktopToolGrants: { browser: true } } : {} })).toThrow(new RegExp(key))
    }
    expect(() => assertExternalMcpAgentMetadataOnlyUpdate({
        agentId: 'a',
        description: 'keep me',
        tools: { desktopToolGrants: { browser: true }, desktopCodexGrants: { shell: true }, desktopWorkspaceRead: true },
        selfImprovement: { enabled: true },
    })).toThrow(/tools/)
    expect(() => assertExternalMcpAgentMetadataOnlyUpdate({
        agentId: 'a',
        description: 'keep me',
        tools: { desktopToolGrants: { browser: true }, desktopCodexGrants: { shell: true }, desktopWorkspaceRead: true },
        selfImprovement: { enabled: true },
    })).toThrow(/selfImprovement/)
})

it('update_agent rejects authority fields before rename/move/patch and never calls patchAgent', async () => {
    vi.resetModules()
    const patchAgent = vi.fn(async () => ({ config: { name: 'A', description: '', connectionId: null, provider: null, model: null }, soul: '' }))
    const getAgent = vi.fn(async () => ({ id: 'eng', config: { name: 'A', description: '', connectionId: null, provider: null, model: null, tools: {}, selfImprovement: {} }, soul: '' }))
    const renameDesktopCoworker = vi.fn(async () => undefined)
    const writeDesktopBoardState = vi.fn(async () => undefined)
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
    const agentRow = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceId: 1, engineAgentId: 'eng', name: 'A', description: '', enabled: true, spaceId: 'space-1' }
    vi.doMock('../store', () => ({
        findDesktopAgent: async () => agentRow,
        listDesktopAgents: async () => [agentRow],
    }))
    vi.doMock('../coworker-rename', () => ({ renameDesktopCoworker }))
    vi.doMock('../spaces', () => ({
        planDesktopAgentPlacement: async () => ({ createSpace: false, space: { id: 'space-1', name: 'Box' }, position: { x: 0, y: 0 } }),
        readDesktopBoardState: async () => ({ revision: 1, spaces: [] }),
        writeDesktopBoardState,
    }))
    vi.doMock('@/lib/engine/client', async () => {
        const actual = await vi.importActual<Record<string, unknown>>('@/lib/engine/client')
        return { ...actual, patchAgent, getAgent }
    })
    const { invokeExternalMcpOperation } = await import('./operations')
    const recheck = async () => ({ ok: true as const, principal })
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const cases: Record<string, unknown>[] = [
        { agentId, tools: { desktopToolGrants: { browser: true } } },
        { agentId, selfImprovement: { enabled: true } },
        { agentId, mcpServers: [{ name: 'x' }] },
        { agentId, desktopToolGrants: { browser: true } },
        { agentId, desktopCodexGrants: { shell: true } },
        { agentId, desktopWorkspaceRead: true },
        { agentId, name: 'ShouldNotRename', description: 'meta', tools: { desktopCodexGrants: { shell: true } } },
    ]
    for (const args of cases) {
        patchAgent.mockClear()
        renameDesktopCoworker.mockClear()
        writeDesktopBoardState.mockClear()
        await expect(invokeExternalMcpOperation(ctx('update_agent', args), new AbortController().signal, { recheck })).rejects.toThrow(/no changes were applied/)
        expect(patchAgent).not.toHaveBeenCalled()
        expect(renameDesktopCoworker).not.toHaveBeenCalled()
        expect(writeDesktopBoardState).not.toHaveBeenCalled()
    }
})

it('update_agent still applies allowed metadata when no authority fields are present', async () => {
    vi.resetModules()
    const patchAgent = vi.fn(async (_e: unknown, _id: string, patch: Record<string, unknown>) => ({
        id: 'eng',
        config: { name: typeof patch.name === 'string' ? patch.name : 'A', description: patch.description ?? '', connectionId: null, provider: null, model: null, tools: {}, selfImprovement: {} },
        soul: patch.soul ?? '',
    }))
    const getAgent = vi.fn(async () => ({ id: 'eng', config: { name: 'A', description: '', connectionId: null, provider: null, model: null, tools: {}, selfImprovement: {} }, soul: '' }))
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
    const agentRow = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceId: 1, engineAgentId: 'eng', name: 'A', description: '', enabled: true, spaceId: 'space-1' }
    vi.doMock('../store', () => ({
        findDesktopAgent: async () => agentRow,
        listDesktopAgents: async () => [agentRow],
    }))
    vi.doMock('../coworker-rename', () => ({ renameDesktopCoworker: vi.fn(async () => undefined) }))
    vi.doMock('../spaces', () => ({
        planDesktopAgentPlacement: async () => ({ createSpace: false, space: { id: 'space-1', name: 'Box' }, position: { x: 0, y: 0 } }),
        readDesktopBoardState: async () => ({ revision: 1, spaces: [] }),
        writeDesktopBoardState: vi.fn(async () => undefined),
    }))
    vi.doMock('@/lib/engine/client', async () => {
        const actual = await vi.importActual<Record<string, unknown>>('@/lib/engine/client')
        return { ...actual, patchAgent, getAgent }
    })
    const { invokeExternalMcpOperation } = await import('./operations')
    const recheck = async () => ({ ok: true as const, principal })
    await invokeExternalMcpOperation(ctx('update_agent', {
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        description: 'new description',
        soul: 'new soul',
        handle: 'NewHandle',
    }), new AbortController().signal, { recheck })
    expect(patchAgent).toHaveBeenCalledTimes(1)
    expect(patchAgent.mock.calls[0][2]).toEqual(expect.objectContaining({
        description: 'new description',
        soul: 'new soul',
        name: 'NewHandle',
    }))
    expect(patchAgent.mock.calls[0][2]).not.toHaveProperty('tools')
    expect(patchAgent.mock.calls[0][2]).not.toHaveProperty('selfImprovement')
})

it('create_agent still refuses tools/selfImprovement before any create write', async () => {
    vi.resetModules()
    const createDescribedDesktopCoworker = vi.fn(async () => ({ agent: { id: 'a', engineAgentId: 'eng', name: 'N', description: '', enabled: true }, sessionId: 's' }))
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
        findDesktopAgent: async () => null,
        listDesktopAgents: async () => [],
    }))
    vi.doMock('../spaces', () => ({
        planDesktopAgentPlacement: async () => ({ createSpace: false, space: { id: 'space-1', name: 'Box' }, position: { x: 0, y: 0 } }),
        readDesktopBoardState: async () => ({ revision: 1, spaces: [] }),
        writeDesktopBoardState: vi.fn(async () => undefined),
    }))
    vi.doMock('../new-agent', () => ({
        createDescribedDesktopCoworker,
        acknowledgeDesktopCreation: vi.fn(async () => undefined),
    }))
    const { invokeExternalMcpOperation } = await import('./operations')
    const recheck = async () => ({ ok: true as const, principal })
    await expect(invokeExternalMcpOperation(ctx('create_agent', {
        name: 'N',
        soul: 'You are N.',
        tools: { desktopToolGrants: { browser: true } },
    }), new AbortController().signal, { recheck })).rejects.toThrow(/Mac Tools panel/)
    expect(createDescribedDesktopCoworker).not.toHaveBeenCalled()
})

it('update_agent authority deny does not require engine identity lookup when payload is rejected first', async () => {
    // Sibling isolation: a read-only-scoped principal still fails closed on authority fields
    // at the adapter gate; scope enforcement for update_agent remains catalog/bridge-owned.
    const { assertExternalMcpAgentMetadataOnlyUpdate } = await import('./operations')
    const readOnlyArgs = {
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tools: { desktopToolGrants: { browser: true } },
    }
    expect(() => assertExternalMcpAgentMetadataOnlyUpdate(readOnlyArgs)).toThrow(/no changes were applied/)
})
