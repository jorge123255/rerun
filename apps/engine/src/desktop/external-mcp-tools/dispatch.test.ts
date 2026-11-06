import { expect, it, vi } from 'vitest'
import type { ExternalMcpCallContext, ExternalMcpPrincipal, ExternalMcpLiveCheckInput } from '@rerun/contracts'
import { createExternalMcpDispatch, createExternalReadDispatch } from './dispatch'

const principal: ExternalMcpPrincipal = {
    version: 1,
    keyId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 1,
    keyRevision: 1,
    scopes: ['mcp:read'],
    installId: '22222222-2222-4222-8222-222222222222',
    launchNonce: '33333333-3333-4333-8333-333333333333',
    runtimeWorkspaceId: 1,
    expiresAt: null,
}
const context: ExternalMcpCallContext = {
    version: 1,
    principal,
    requestId: '44444444-4444-4444-8444-444444444444',
    fingerprint: 'a'.repeat(64),
    tool: 'list_agents',
    arguments: {},
}
const readTools = [{ name: 'list_agents', description: 'Original description', inputSchema: {}, scope: 'mcp:read' as const, effect: false }]
const writeTools = [
    ...readTools,
    { name: 'send_message', description: 'Send', inputSchema: {}, scope: 'runs:send' as const, effect: true },
    { name: 'delete_agent', description: 'Delete', inputSchema: {}, scope: 'coworkers:write' as const, effect: true },
]

it('suppresses a result when authority is revoked during the domain await', async () => {
    let revoked = false
    const port = createExternalReadDispatch({
        tools: readTools,
        recheck: async () => (revoked ? { ok: false, code: 'revoked', message: 'Revoked' } : { ok: true, principal }),
        read: async () => {
            revoked = true
            return { agents: [] }
        },
    })
    await expect(port.callTool(context, new AbortController().signal)).rejects.toThrow('authority')
})

it('does not invoke an unknown operation or any operation after cancellation', async () => {
    const read = vi.fn()
    const port = createExternalReadDispatch({ tools: readTools, recheck: async () => ({ ok: true, principal }), read })
    await expect(port.callTool({ ...context, tool: 'send_message' }, new AbortController().signal)).rejects.toThrow('Unsupported')
    const stop = new AbortController()
    stop.abort()
    await expect(port.callTool(context, stop.signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
})

it('refuses oversized output without producing malformed/truncated JSON', async () => {
    const port = createExternalReadDispatch({
        tools: readTools,
        recheck: async () => ({ ok: true, principal }),
        read: async () => ({ text: 'x'.repeat(60_001) }),
    })
    await expect(port.callTool(context, new AbortController().signal)).rejects.toThrow('too large')
})

it('passes the full mixed grant to recheck while admitting only authorized scopes', async () => {
    const mixed: ExternalMcpPrincipal = { ...principal, scopes: ['mcp:read', 'runs:send'] }
    const recheck = vi.fn(async (_input: ExternalMcpLiveCheckInput) => ({ ok: true as const, principal: mixed }))
    const invoke = vi.fn(async () => ({ ok: true }))
    const port = createExternalMcpDispatch({ tools: writeTools, recheck, invoke })
    await port.callTool({ ...context, principal: mixed, tool: 'send_message' }, new AbortController().signal)
    expect(recheck.mock.calls.every(call => call[0].scopes.join(',') === 'mcp:read,runs:send')).toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
    const listed = await port.listTools(mixed)
    expect(listed.map(tool => tool.name).sort()).toEqual(['list_agents', 'send_message'])
})

it('refuses a write-only key before invoking a read tool and refuses missing write scopes', async () => {
    const invoke = vi.fn()
    const port = createExternalMcpDispatch({
        tools: writeTools,
        recheck: async () => ({ ok: true, principal }),
        invoke,
    })
    await expect(port.callTool({ ...context, principal: { ...principal, scopes: ['runs:send'] }, tool: 'list_agents' }, new AbortController().signal)).rejects.toThrow('Missing scope')
    await expect(port.callTool({ ...context, tool: 'delete_agent' }, new AbortController().signal)).rejects.toThrow('Missing scope')
    expect(invoke).not.toHaveBeenCalled()
})

it('rejects invalid scope/effect pairing at construction', () => {
    expect(() => createExternalMcpDispatch({
        tools: [{ name: 'bad', description: 'bad', inputSchema: {}, scope: 'mcp:read', effect: true }],
        recheck: async () => ({ ok: true, principal }),
        invoke: async () => ({}),
    })).toThrow('scope/effect')
})

it('does not advertise or execute creation without both coworker-write and first-run access', async () => {
    const create = { name: 'create_agent', description: 'Create and start a coworker.', inputSchema: {}, scope: 'coworkers:write' as const, effect: true }
    const write: ExternalMcpPrincipal = { ...principal, scopes: ['mcp:read', 'coworkers:write'] }
    const invoke = vi.fn(async () => ({}))
    const port = createExternalMcpDispatch({ tools: [...readTools, create], recheck: async () => ({ ok: true, principal: write }), invoke })
    expect((await port.listTools(write)).map(tool => tool.name)).toEqual(['list_agents'])
    await expect(port.callTool({ ...context, principal: write, tool: 'create_agent' }, new AbortController().signal)).rejects.toThrow(/Missing scope/)
    expect(invoke).not.toHaveBeenCalled()
    const all: ExternalMcpPrincipal = { ...write, scopes: [...write.scopes, 'runs:send'] }
    const allowed = createExternalMcpDispatch({ tools: [create], recheck: async () => ({ ok: true, principal: all }), invoke })
    expect((await allowed.listTools(all)).map(tool => tool.name)).toEqual(['create_agent'])
})
