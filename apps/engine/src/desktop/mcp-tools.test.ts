import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ToolSet } from 'ai'
import type { RunContext } from '../runtime/context.js'
const state = vi.hoisted(() => ({ enabled: true, granted: true, release: vi.fn() }))
vi.mock('../config/env.js', () => ({ env: () => ({ RERUN_HUB_BASE_URL: 'http://127.0.0.1:3123', RERUN_API_KEY: 'engine-only' }) }))
vi.mock('../agents/lock.js', () => ({ withAgentLock: async (_id: string, action: () => Promise<unknown>) => action() }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => ({ enabled: state.enabled, tools: { desktopToolGrants: { mcp: state.granted } } }) }))
vi.mock('./agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => state.release }))
import { desktopMcpTools, isDesktopMcpTool, stopDesktopMcp } from './mcp-tools.js'

const catalogId = '00000000-0000-4000-8000-000000000001', capabilityId = '00000000-0000-4000-8000-000000000002'
const catalog = { catalogId, tools: [{ capabilityId, name: 'public_add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } }] }
const result = { source: 'remote_mcp', untrusted: true, result: { content: [{ type: 'text', text: '42' }] } }
const ctx = (signal = new AbortController().signal) => ({ agent: { id: 'engine-owner', config: { enabled: true, tools: { desktopToolGrants: { mcp: state.granted } } } }, sessionId: 'session', runId: 'run', abortSignal: signal, logger: { warn: vi.fn() } } as unknown as RunContext)
const execute = (tools: ToolSet, callId = 'call-1') => (tools.public_add as unknown as { execute: (args: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown> }).execute({ a: 17, b: 25 }, { toolCallId: callId, messages: [] })
beforeEach(() => { state.enabled = true; state.granted = true; state.release.mockClear() })
afterEach(() => { vi.unstubAllGlobals() })

test('turns real catalog schemas into marked bridgeable tools and binds results to the same invocation', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('http://127.0.0.1:3123/api/desktop/internal/mcp')
        expect(init.headers).toMatchObject({ Authorization: 'Bearer engine-only' })
        const body = JSON.parse(String(init.body)); bodies.push(body)
        return Response.json(body.action === 'catalog' ? catalog : body.action === 'call' ? { toolCallId: body.toolCallId, result } : { released: true })
    })
    vi.stubGlobal('fetch', fetcher)
    const built = await desktopMcpTools(ctx())
    try {
        expect(isDesktopMcpTool(built.tools.public_add)).toBe(true)
        expect(isDesktopMcpTool({ ...built.tools.public_add })).toBe(false)
        expect(built.tools.public_add.inputSchema).toHaveProperty('_def')
        expect(JSON.parse(String(await execute(built.tools)))).toEqual(result)
        expect(bodies[1]).toMatchObject({ action: 'call', engineAgentId: 'engine-owner', sessionId: 'session', runId: 'run', catalogId, capabilityId, toolCallId: 'call-1', arguments: { a: 17, b: 25 } })
        expect(bodies[1]).not.toHaveProperty('url')
    } finally { await built.close() }
    expect(bodies.at(-1)).toMatchObject({ action: 'release', catalogId })
})

test('default-off and a newly revoked grant make no remote call', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => Response.json(JSON.parse(String(init.body)).action === 'catalog' ? catalog : { released: true }))
    vi.stubGlobal('fetch', fetcher)
    state.granted = false
    expect((await desktopMcpTools(ctx())).tools).toEqual({})
    expect(fetcher).not.toHaveBeenCalled()
    state.granted = true
    const built = await desktopMcpTools(ctx())
    state.granted = false
    await expect(execute(built.tools)).rejects.toThrow('turned off')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await built.close()
})

test.each(['wrong-id', 'remote-error'] as const)('does not publish %s as a successful tool result', async mode => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        return Response.json(body.action === 'catalog' ? catalog : body.action === 'call'
            ? { toolCallId: mode === 'wrong-id' ? 'another-call' : body.toolCallId, result: { ...result, result: { ...result.result, ...(mode === 'remote-error' ? { isError: true } : {}) } } }
            : { released: true })
    }))
    const built = await desktopMcpTools(ctx())
    try { await expect(execute(built.tools)).rejects.toThrow(mode === 'wrong-id' ? 'another call' : '"isError":true') }
    finally { await built.close() }
})

test('shutdown requires the UI authority to acknowledge terminal admission closure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ stopped: true })))
    await expect(stopDesktopMcp()).resolves.toBeUndefined()
})

test('run Stop aborts an in-flight callback and releases the server catalog', async () => {
    const run = new AbortController(), bodies: { action: string }[] = []
    let entered!: () => void
    const calling = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)); bodies.push(body)
        if (body.action === 'catalog') return Response.json(catalog)
        if (body.action === 'release') return Response.json({ released: true })
        entered()
        return new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        })
    }))
    const built = await desktopMcpTools(ctx(run.signal))
    const pending = execute(built.tools), stopped = expect(pending).rejects.toThrow('stopped')
    await calling
    run.abort()
    await stopped; await built.close()
    expect(bodies.map(body => body.action)).toEqual(['catalog', 'call', 'release'])
    expect(state.release).toHaveBeenCalled()
})

test('Stop during discovery explicitly releases the run before a catalog id is known', async () => {
    const run = new AbortController(), bodies: Record<string, unknown>[] = []
    let entered!: () => void
    const discovering = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)); bodies.push(body)
        if (body.action === 'release') return Response.json({ released: true })
        entered()
        return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
    }))
    const preparing = desktopMcpTools(ctx(run.signal)), refused = expect(preparing).rejects.toThrow('stopped')
    await discovering; run.abort(); await refused
    expect(bodies.map(body => body.action)).toEqual(['catalog', 'release'])
    expect(bodies[1]).toMatchObject({ engineAgentId: 'engine-owner', sessionId: 'session', runId: 'run' })
    expect(bodies[1]).not.toHaveProperty('catalogId')
})
