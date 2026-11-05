import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ tools: vi.fn(), execute: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('./tools', () => ({ remoteMcpTools: mocks.tools }))
import { desktopMcpBridge, desktopMcpBridgeRequest } from './bridge'
import { remoteMcpLifecycle } from './lifecycle'
import type { RemoteMcpStore } from './store'
import type { remoteMcpRuntime } from './remote'

const identity = { engineAgentId: 'engine-owner', sessionId: 'session', runId: 'run' }
const bridges: ReturnType<typeof desktopMcpBridge>[] = []
function fixture() {
    const authorize = vi.fn(async (_identity: unknown, signal: AbortSignal) => { signal.throwIfAborted(); return 'local-owner' })
    const store = { lifecycle: remoteMcpLifecycle() } as unknown as RemoteMcpStore
    const bridge = desktopMcpBridge(store, {} as ReturnType<typeof remoteMcpRuntime>, authorize)
    bridges.push(bridge)
    const handle = (body: unknown, signal = new AbortController().signal) => bridge.handle(desktopMcpBridgeRequest.parse(body), signal)
    return { bridge, handle, authorize }
}
beforeEach(() => {
    mocks.execute.mockReset().mockResolvedValue({ source: 'remote_mcp', untrusted: true, result: { content: [{ type: 'text', text: '42' }] } })
    mocks.tools.mockReset().mockResolvedValue([{ name: 'public_add', description: 'Add', inputSchema: { type: 'object' }, execute: mocks.execute }])
})
afterEach(() => { for (const bridge of bridges) bridge.shutdown(); bridges.length = 0 })
type Catalog = { catalogId: string; tools: { capabilityId: string; name: string }[] }
const discover = async (handle: ReturnType<typeof fixture>['handle']) => await handle({ action: 'catalog', ...identity }) as Catalog

test('binds opaque tools to one owner/session/run and never repeats a submitted call id', async () => {
    const { handle } = fixture(), catalog = await discover(handle)
    const call = { action: 'call', ...identity, catalogId: catalog.catalogId, capabilityId: catalog.tools[0].capabilityId, toolCallId: 'call-1', arguments: { a: 17, b: 25 } }
    await expect(handle({ ...call, engineAgentId: 'other' })).rejects.toThrow('another run')
    await expect(handle({ ...call, capabilityId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow('unavailable')
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(await handle(call)).toMatchObject({ toolCallId: 'call-1', result: { source: 'remote_mcp', untrusted: true } })
    await expect(handle(call)).rejects.toThrow('already submitted')
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(Object.keys(catalog.tools[0]).sort()).toEqual(['capabilityId', 'description', 'inputSchema', 'name'])
})

test('an owner transition discards a late remote result and permanently invalidates its catalog', async () => {
    const { bridge, handle } = fixture(), catalog = await discover(handle)
    let complete!: (value: unknown) => void
    mocks.execute.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = handle({ action: 'call', ...identity, catalogId: catalog.catalogId, capabilityId: catalog.tools[0].capabilityId, toolCallId: 'late', arguments: {} })
    const refusal = expect(pending).rejects.toThrow()
    await Promise.resolve(); await Promise.resolve()
    bridge.invalidateOwner('local-owner')
    complete({ source: 'remote_mcp', untrusted: true, result: { content: [] } })
    await refusal
    await expect(handle({ action: 'call', ...identity, catalogId: catalog.catalogId, capabilityId: catalog.tools[0].capabilityId, toolCallId: 'later', arguments: {} })).rejects.toThrow('another run')
})

test('release by authenticated run identity cancels discovery whose response was lost', async () => {
    const { handle } = fixture()
    let complete!: (value: unknown[]) => void
    mocks.tools.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = discover(handle), refused = expect(pending).rejects.toThrow()
    await Promise.resolve(); await Promise.resolve()
    expect(await handle({ action: 'release', ...identity })).toEqual({ released: true })
    complete([])
    await refused
    await expect(discover(handle)).rejects.toThrow('admission unavailable')
})

test('shutdown is terminal and the bridge refuses arbitrary endpoint or tool-name requests', async () => {
    const { handle } = fixture()
    expect(desktopMcpBridgeRequest.safeParse({ action: 'catalog', ...identity, url: 'https://outside.invalid' }).success).toBe(false)
    await handle({ action: 'shutdown' })
    await expect(discover(handle)).rejects.toThrow('stopped')
    expect(mocks.tools).not.toHaveBeenCalled()
})
