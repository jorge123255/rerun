import { expect, it, vi } from 'vitest'
import type { ExternalMcpPrincipal } from '@rerun/contracts'

vi.mock('../internal-client.js', () => ({ desktopInternalJson: vi.fn() }))
import { desktopInternalJson } from '../internal-client.js'
import { createExternalMcpUiDispatch } from './bridge.js'

const principal: ExternalMcpPrincipal = { version: 1, keyId: '11111111-1111-4111-8111-111111111111', workspaceId: 2, keyRevision: 1, scopes: ['mcp:read'], installId: '22222222-2222-4222-8222-222222222222', launchNonce: '33333333-3333-4333-8333-333333333333', runtimeWorkspaceId: 2, expiresAt: null }

it('uses only the authenticated internal callback and rechecks both sides of a list read', async () => {
    vi.clearAllMocks()
    const recheck = vi.fn(async () => ({ ok: true as const, principal }))
    const tools = [{ name: 'list_agents', description: 'List coworkers.', inputSchema: { type: 'object' }, scope: 'mcp:read', effect: false }]
    vi.mocked(desktopInternalJson).mockResolvedValueOnce(tools)
    expect(await createExternalMcpUiDispatch({ recheck }).listTools(principal)).toEqual(tools)
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(desktopInternalJson).toHaveBeenCalledWith('/api/desktop/internal/external-mcp-tools', { action: 'list', principal }, expect.any(AbortSignal), 1_100_000)
})

it('refuses revoked authority before a callback and discards a response revoked during its await', async () => {
    vi.clearAllMocks()
    const refused = { ok: false as const, code: 'revoked' as const, message: 'Revoked.' }
    const recheck = vi.fn().mockResolvedValueOnce(refused)
    const dispatch = createExternalMcpUiDispatch({ recheck })
    const context = { version: 1 as const, requestId: '44444444-4444-4444-8444-444444444444', fingerprint: 'a'.repeat(64), principal, tool: 'list_agents', arguments: {} }
    await expect(dispatch.callTool(context, new AbortController().signal)).rejects.toThrow(/authority/)
    expect(desktopInternalJson).not.toHaveBeenCalled()
    recheck.mockResolvedValueOnce({ ok: true, principal }).mockResolvedValueOnce(refused)
    vi.mocked(desktopInternalJson).mockResolvedValueOnce({ content: [{ type: 'text', text: 'must not return' }] })
    await expect(dispatch.callTool(context, new AbortController().signal)).rejects.toThrow(/authority/)
})

it('never calls the UI for an already cancelled request', async () => {
    vi.clearAllMocks()
    const controller = new AbortController(); controller.abort()
    await expect(createExternalMcpUiDispatch({ recheck: async () => ({ ok: true, principal }) }).callTool({ version: 1, requestId: '44444444-4444-4444-8444-444444444444', fingerprint: 'a'.repeat(64), principal, tool: 'list_agents', arguments: {} }, controller.signal)).rejects.toThrow()
    expect(desktopInternalJson).not.toHaveBeenCalled()
})
