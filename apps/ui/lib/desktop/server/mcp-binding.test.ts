import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from './runtime'
const mocks = vi.hoisted(() => ({ open: vi.fn(), createStore: vi.fn(), access: undefined as undefined | ((id: string) => Promise<unknown>), execute: vi.fn(), schema: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('./runtime', () => ({ readDesktopRuntime: async () => runtime }))
vi.mock('./database', () => ({ openDesktopDatabase: mocks.open }))
vi.mock('./mcp/store', async original => {
    const actual = await original<typeof import('./mcp/store')>()
    return { ...actual, remoteMcpStore: (...args: Parameters<typeof actual.remoteMcpStore>) => { mocks.createStore(); return actual.remoteMcpStore(...args) } }
})
vi.mock('./mcp/remote', async original => {
    const actual = await original<typeof import('./mcp/remote')>()
    return { ...actual, remoteMcpRuntime: (...args: Parameters<typeof actual.remoteMcpRuntime>) => { mocks.access = args[1]; return actual.remoteMcpRuntime(...args) } }
})
import { getDesktopRemoteMcpService, handleDesktopMcpBridge, handleDesktopMcpManagement, shutdownDesktopRemoteMcp, withDesktopMcpOwnerTransition } from './mcp-binding'
const runtime: DesktopRuntime = { protocolVersion: 1, workspaceId: 1, dataRoot: '/test-only-mcp', launchNonce: 'launch', buildId: 'test', app: { origin: 'http://127.0.0.1:3001', sessionToken: 'unused' }, engine: { origin: 'http://127.0.0.1:3002', apiKey: 'engine-only' } }
const db = { execute: mocks.execute, executeMultiple: mocks.schema }
beforeEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for('rerun.desktop.remote-mcp.services.v1'))
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'a'.repeat(64))
    mocks.open.mockReset().mockResolvedValue(db); mocks.schema.mockReset().mockResolvedValue(undefined); mocks.createStore.mockClear()
    mocks.execute.mockReset().mockResolvedValue({ rows: [{ id: 'local-owner', engine_agent_id: 'engine-owner' }] })
    mocks.access = undefined
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); Reflect.deleteProperty(globalThis, Symbol.for('rerun.desktop.remote-mcp.services.v1')) })

test('separately imported route modules receive the exact same process-wide authority', async () => {
    const first = await getDesktopRemoteMcpService(runtime)
    vi.resetModules()
    const independentlyBundled = await import('./mcp-binding')
    expect(await independentlyBundled.getDesktopRemoteMcpService(runtime)).toBe(first)
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(mocks.createStore).toHaveBeenCalledTimes(1)
})

test('a legacy mutation needs no store/key, and terminal shutdown prevents later initialization', async () => {
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '')
    const write = vi.fn(async () => 'saved')
    expect(await withDesktopMcpOwnerTransition(runtime, 'local-owner', write)).toBe('saved')
    expect(mocks.open).not.toHaveBeenCalled()
    await shutdownDesktopRemoteMcp(runtime)
    await expect(getDesktopRemoteMcpService(runtime)).rejects.toThrow('stopped')
    expect(mocks.open).not.toHaveBeenCalled()
})

test('a transition reserved during initialization blocks authority until its mutation settles', async () => {
    let open!: (value: typeof db) => void, finish!: () => void, entered!: () => void
    const writing = new Promise<void>(resolve => { entered = resolve })
    mocks.open.mockImplementationOnce(() => new Promise(resolve => { open = resolve }))
    const opening = getDesktopRemoteMcpService(runtime)
    const transition = withDesktopMcpOwnerTransition(runtime, 'local-owner', () => { entered(); return new Promise<void>(resolve => { finish = resolve }) })
    open(db); await opening; await writing
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'engine-owner', config: { enabled: true, tools: { desktopToolGrants: { mcp: true } } } })))
    vi.stubGlobal('fetch', fetcher)
    await expect(mocks.access!('local-owner')).rejects.toThrow('changing')
    expect(fetcher).not.toHaveBeenCalled()
    finish(); await transition
    expect(await mocks.access!('local-owner')).toEqual({ enabled: true, granted: true })
})

test('engine callbacks require the exact engine key and Host, while management requires the renderer session', async () => {
    const callback = (headers: Record<string, string>) => new Request(`${runtime.app.origin}/api/desktop/internal/mcp`, { method: 'POST', headers, body: JSON.stringify({ action: 'shutdown' }) })
    expect((await handleDesktopMcpBridge(callback({ host: '127.0.0.1:3001', cookie: 'rerun-desktop-session=unused' }))).status).toBe(401)
    expect((await handleDesktopMcpBridge(callback({ host: 'localhost:3001', authorization: 'Bearer engine-only' }))).status).toBe(403)
    const management = new Request(`${runtime.app.origin}/api/desktop/coworkers/local-owner/mcp`, { headers: { host: '127.0.0.1:3001', authorization: 'Bearer engine-only' } })
    expect((await handleDesktopMcpManagement(management, 'local-owner')).status).toBe(401)
    expect(mocks.open).not.toHaveBeenCalled()
    const accepted = await handleDesktopMcpBridge(callback({ host: '127.0.0.1:3001', authorization: 'Bearer engine-only' }))
    expect(await accepted.json()).toEqual({ stopped: true })
    expect(mocks.open).not.toHaveBeenCalled()
})

test('failed in-progress initialization does not prevent an owner disable or delete', async () => {
    let reject!: (error: Error) => void
    mocks.open.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
    const opening = getDesktopRemoteMcpService(runtime), failed = expect(opening).rejects.toThrow('database unavailable')
    const write = vi.fn(async () => 'disabled')
    const transition = withDesktopMcpOwnerTransition(runtime, 'local-owner', write)
    expect(write).not.toHaveBeenCalled()
    reject(new Error('database unavailable'))
    await failed
    expect(await transition).toBe('disabled')
    expect(write).toHaveBeenCalledTimes(1)
    expect(mocks.createStore).not.toHaveBeenCalled()
})
