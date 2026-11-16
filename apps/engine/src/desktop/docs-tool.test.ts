import { expect, it, vi } from 'vitest'

const grants = vi.hoisted(() => ({ has: vi.fn(), require: vi.fn() }))
vi.mock('./tool-grants.js', () => ({ hasDesktopToolGrant: grants.has, requireDesktopToolGrant: grants.require }))
vi.mock('./agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => () => {} }))
vi.mock('./internal-client.js', () => ({ desktopInternalJson: vi.fn() }))
import { desktopDocsTools } from './docs-tool.js'

const ctx = { agent: { id: 'agent-a', config: {} }, sessionId: 'session-a', runId: 'run-a', abortSignal: new AbortController().signal } as never

it('offers nothing without the Rerun documentation permission', () => {
    grants.has.mockReturnValue(false)
    expect(desktopDocsTools(ctx, vi.fn())).toEqual({})
})

it('rechecks the permission, then asks the app with this run and tool call', async () => {
    grants.has.mockReturnValue(true); grants.require.mockResolvedValue(undefined)
    const search = vi.fn(async () => ({ status: 'ok', passages: [] }))
    const tools = desktopDocsTools(ctx, search)
    const result = await (tools.search_docs as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute({ query: 'how do routines work' }, { toolCallId: 'call-1', abortSignal: new AbortController().signal })
    expect(grants.require).toHaveBeenCalledWith(expect.anything(), 'docs')
    expect(search).toHaveBeenCalledWith({ agentId: 'agent-a', sessionId: 'session-a', runId: 'run-a', toolCallId: 'call-1' }, 'how do routines work', expect.any(AbortSignal))
    expect(result).toEqual({ status: 'ok', passages: [] })
})

it('stops when the permission was withdrawn', async () => {
    grants.has.mockReturnValue(true); grants.require.mockRejectedValue(new Error('not granted'))
    const search = vi.fn()
    const tools = desktopDocsTools(ctx, search)
    await expect((tools.search_docs as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute({ query: 'x y z' }, { toolCallId: 'call-2', abortSignal: new AbortController().signal })).rejects.toThrow('not granted')
    expect(search).not.toHaveBeenCalled()
})
