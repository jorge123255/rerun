import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    runtime: { workspaceId: 2, dataRoot: '/fixture' },
    list: vi.fn(),
    execute: vi.fn(async () => ({ rows: [] })),
}))
vi.mock('../server/auth', () => ({ authenticateDesktopRequest: async () => state.runtime, DesktopHttpError: class extends Error { constructor(readonly status: number, message: string) { super(message) } } }))
vi.mock('../server/database', () => ({ openDesktopDatabase: async () => ({ execute: state.execute }) }))
vi.mock('../server/external-mcp-authority/client', () => ({ listDesktopExternalMcpKeys: state.list, createDesktopExternalMcpKey: vi.fn(), revokeDesktopExternalMcpKey: vi.fn(), readDesktopExternalMcpListener: vi.fn(), enableDesktopExternalMcpListener: vi.fn(), disableDesktopExternalMcpListener: vi.fn() }))
import { handleDesktopExternalMcpAttempts, handleDesktopExternalMcpKeys } from './api'

beforeEach(() => {
    vi.clearAllMocks()
    state.list.mockResolvedValue({ version: 1, workspaceId: 2, keys: [] })
})

it('parses an exact numeric workspace query for both keys and the durable attempt journal', async () => {
    const keys = await handleDesktopExternalMcpKeys(new Request('http://127.0.0.1/api/desktop/external-mcp/keys?workspaceId=2'))
    expect(keys.status).toBe(200)
    expect(state.list).toHaveBeenCalledWith(state.runtime, 2)
    const attempts = await handleDesktopExternalMcpAttempts(new Request('http://127.0.0.1/api/desktop/external-mcp/attempts?workspaceId=2'))
    expect(attempts.status).toBe(200)
    expect(await attempts.json()).toEqual({ attempts: [] })
    expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({ args: [2] }))
})

it.each(['', '0', '-1', '1.5', '2e0', 'other'])('rejects malformed workspace query %s before consulting key storage', async value => {
    expect((await handleDesktopExternalMcpKeys(new Request(`http://127.0.0.1/api/desktop/external-mcp/keys?workspaceId=${value}`))).status).toBe(400)
    expect(state.list).not.toHaveBeenCalled()
})

it('refuses a well-formed different workspace rather than selecting it from a query', async () => {
    expect((await handleDesktopExternalMcpKeys(new Request('http://127.0.0.1/api/desktop/external-mcp/keys?workspaceId=3'))).status).toBe(409)
    expect(state.list).not.toHaveBeenCalled()
})
