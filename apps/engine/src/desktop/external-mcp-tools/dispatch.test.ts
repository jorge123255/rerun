import { expect, it, vi } from 'vitest'
import type { ExternalMcpCallContext, ExternalMcpPrincipal, ExternalMcpLiveCheckInput } from '@rerun/contracts'
import { createExternalReadDispatch } from './dispatch'
const principal: ExternalMcpPrincipal = { version: 1, keyId: '11111111-1111-4111-8111-111111111111', workspaceId: 1, keyRevision: 1, scopes: ['mcp:read'], installId: '22222222-2222-4222-8222-222222222222', launchNonce: '33333333-3333-4333-8333-333333333333', runtimeWorkspaceId: 1, expiresAt: null }
const context: ExternalMcpCallContext = { version: 1, principal, requestId: '44444444-4444-4444-8444-444444444444', fingerprint: 'a'.repeat(64), tool: 'list_agents', arguments: {} }
const tools = [{ name: 'list_agents', description: 'Original description', inputSchema: {}, scope: 'mcp:read' as const, effect: false }]
it('suppresses a result when authority is revoked during the domain await', async () => {
    let revoked = false
    const port = createExternalReadDispatch({ tools, recheck: async () => revoked ? { ok: false, code: 'revoked', message: 'Revoked' } : { ok: true, principal }, read: async () => { revoked = true; return { agents: [] } } })
    await expect(port.callTool(context, new AbortController().signal)).rejects.toThrow('authority')
})
it('does not invoke an unknown operation or any operation after cancellation', async () => {
    const read = vi.fn()
    const port = createExternalReadDispatch({ tools, recheck: async () => ({ ok: true, principal }), read })
    await expect(port.callTool({ ...context, tool: 'send_message' }, new AbortController().signal)).rejects.toThrow('Unsupported')
    const stop = new AbortController(); stop.abort()
    await expect(port.callTool(context, stop.signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
})
it('refuses oversized output without producing malformed/truncated JSON', async () => {
    const port = createExternalReadDispatch({ tools, recheck: async () => ({ ok: true, principal }), read: async () => ({ text: 'x'.repeat(60_001) }) })
    await expect(port.callTool(context, new AbortController().signal)).rejects.toThrow('too large')
})
it('passes the full mixed grant to recheck while admitting only read operations', async () => {
    const mixed: ExternalMcpPrincipal = { ...principal, scopes: ['mcp:read', 'runs:send'] }
    const recheck = vi.fn(async (_input: ExternalMcpLiveCheckInput) => ({ ok: true as const, principal: mixed }))
    const port = createExternalReadDispatch({ tools, recheck, read: async () => ({ agents: [] }) })
    await port.callTool({ ...context, principal: mixed }, new AbortController().signal)
    expect(recheck.mock.calls.every(call => call[0].scopes.join(',') === 'mcp:read,runs:send')).toBe(true)
})
it('refuses a write-only key before invoking the domain reader', async () => {
    const read = vi.fn()
    const port = createExternalReadDispatch({ tools, recheck: async () => ({ ok: true, principal }), read })
    await expect(port.callTool({ ...context, principal: { ...principal, scopes: ['runs:send'] } }, new AbortController().signal)).rejects.toThrow('Read scope')
    expect(read).not.toHaveBeenCalled()
})
