import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    runtime: { protocolVersion: 1, workspaceId: 2, installId: '22222222-2222-4222-8222-222222222222', launchNonce: '33333333-3333-4333-8333-333333333333', buildId: 'fixture', dataRoot: '/fixture', app: { origin: 'http://127.0.0.1:3000', sessionToken: 'x'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3001', apiKey: 'e'.repeat(64) } },
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'result' }] })),
    recheck: vi.fn(),
    factory: vi.fn(),
    importKey: vi.fn(),
    admit: vi.fn(),
    settle: vi.fn(),
}))
vi.mock('../database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('./import-keys', () => ({ readDesktopImportKey: state.importKey, admitDesktopImportCall: state.admit, desktopImportToolNames: new Set(['get_agent', 'create_agent']) }))
vi.mock('../runtime', () => ({ readDesktopRuntime: async () => state.runtime }))
vi.mock('../external-mcp-authority/client', () => ({ recheckDesktopExternalMcp: state.recheck }))
vi.mock('./factory', () => ({ createLocalExternalMcpTools: state.factory }))
import { createDesktopExternalMcpToolsHandler } from './bridge'

const principal = { version: 1, keyId: '11111111-1111-4111-8111-111111111111', workspaceId: 2, keyRevision: 1, scopes: ['mcp:read'], installId: state.runtime.installId, launchNonce: state.runtime.launchNonce, runtimeWorkspaceId: 2, expiresAt: null }
const request = (body: unknown, authorization = `Bearer ${state.runtime.engine.apiKey}`, host = '127.0.0.1:3000') => new Request(`${state.runtime.app.origin}/api/desktop/internal/external-mcp-tools`, { method: 'POST', headers: { host, authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
    vi.clearAllMocks()
    state.recheck.mockResolvedValue({ ok: true, principal })
    state.factory.mockReturnValue({ listTools: state.listTools, callTool: state.callTool })
    state.importKey.mockResolvedValue(null)
    state.admit.mockResolvedValue(null)
})

it('requires the real engine credential and exact app Host before consulting any tool authority', async () => {
    const handle = createDesktopExternalMcpToolsHandler()
    expect((await handle(request({ action: 'list', principal }, 'Bearer wrong'))).status).toBe(401)
    expect((await handle(request({ action: 'list', principal }, undefined, 'other:3000'))).status).toBe(403)
    expect(state.recheck).not.toHaveBeenCalled()
    expect(state.factory).not.toHaveBeenCalled()
})

it.each(['workspaceId', 'runtimeWorkspaceId', 'installId', 'launchNonce'] as const)('rejects changed %s before creating a dispatch port', async field => {
    const foreign = { ...principal, [field]: field.includes('Workspace') || field === 'workspaceId' ? 3 : '44444444-4444-4444-8444-444444444444' }
    expect((await createDesktopExternalMcpToolsHandler()(request({ action: 'list', principal: foreign }))).status).toBe(409)
    expect(state.factory).not.toHaveBeenCalled()
})

it('lists through current authority without supplying renderer credentials or invoking tools', async () => {
    const response = await createDesktopExternalMcpToolsHandler()(request({ action: 'list', principal }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    expect(state.recheck).toHaveBeenCalled()
    expect(state.listTools).toHaveBeenCalledWith(principal)
    expect(state.callTool).not.toHaveBeenCalled()
})

it('refuses a revoked key before tool/service binding', async () => {
    state.recheck.mockResolvedValueOnce({ ok: false, code: 'revoked', message: 'Revoked.' })
    const services = vi.fn()
    expect((await createDesktopExternalMcpToolsHandler({ services })(request({ action: 'list', principal }))).status).toBe(409)
    expect(services).not.toHaveBeenCalled()
    expect(state.factory).not.toHaveBeenCalled()
})

const tool = (name: string) => ({ name, description: 'A fixture tool for the bridge test.', inputSchema: { type: 'object' }, scope: 'mcp:read', effect: false })
const call = (name: string, args: Record<string, unknown> = {}) => ({ action: 'call', context: { version: 1, requestId: '44444444-4444-4444-8444-444444444444', fingerprint: 'a'.repeat(64), principal, tool: name, arguments: args } })

it('shows an import key only the import tools, and any other key all of them', async () => {
    state.listTools.mockResolvedValue([tool('get_agent'), tool('list_agents')] as never)
    expect((await (await createDesktopExternalMcpToolsHandler()(request({ action: 'list', principal }))).json()).map((item: { name: string }) => item.name)).toEqual(['get_agent', 'list_agents'])
    state.importKey.mockResolvedValue({ keyId: principal.keyId, source: 'openclaw', boundAgentId: null, claim: null })
    expect((await (await createDesktopExternalMcpToolsHandler()(request({ action: 'list', principal }))).json()).map((item: { name: string }) => item.name)).toEqual(['get_agent'])
})

it('refuses a call an import key may not make before any tool runs', async () => {
    state.admit.mockRejectedValue(new Error('"delete_agent" is not available to an import key.'))
    const response = await createDesktopExternalMcpToolsHandler()(request(call('delete_agent')))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ content: [{ type: 'text', text: '"delete_agent" is not available to an import key.' }], isError: true })
    expect(state.callTool).not.toHaveBeenCalled()
})

it('binds an import key to the coworker it creates, and frees its claim when the creation fails', async () => {
    state.admit.mockResolvedValue({ settle: state.settle })
    state.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: '{}' }], structuredContent: { agent: { id: 'coworker-1' } } } as never)
    expect((await createDesktopExternalMcpToolsHandler()(request(call('create_agent', { name: 'Imported' })))).status).toBe(200)
    expect(state.admit).toHaveBeenCalledWith({}, principal.keyId, 'create_agent', { name: 'Imported' }, '44444444-4444-4444-8444-444444444444')
    expect(state.settle).toHaveBeenLastCalledWith('coworker-1')
    state.callTool.mockRejectedValueOnce(new Error('creation failed'))
    expect((await createDesktopExternalMcpToolsHandler()(request(call('create_agent', { name: 'Imported' })))).status).toBe(409)
    expect(state.settle).toHaveBeenLastCalledWith(null)
})
