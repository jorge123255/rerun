import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const runtime = { protocolVersion: 1, launchNonce: 'c1111111-1111-4111-8111-111111111111', buildId: 'test', workspaceId: 1, dataRoot: '/desktop-test', app: { origin: 'http://127.0.0.1:3210', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'b'.repeat(64) } }
const mocks = vi.hoisted(() => ({
    read: vi.fn(), serve: vi.fn(), prepare: vi.fn(), reconcile: vi.fn(), bind: vi.fn(), start: vi.fn(), abort: vi.fn(), mcp: vi.fn(), closeMcp: vi.fn(),
    send: vi.fn(), exit: vi.fn(), close: vi.fn(), drain: vi.fn(), stop: vi.fn(), bindingClose: vi.fn(), events: new Map<string, (...args: unknown[]) => void>(),
}))
vi.mock('node:fs/promises', () => ({ readFile: mocks.read, realpath: async (path: string) => path }))
vi.mock('@hono/node-server', () => ({ serve: mocks.serve }))
vi.mock('../../config/env.js', () => ({ env: () => ({ RERUN_HOST: '127.0.0.1', RERUN_PORT: 3222, RERUN_HUB_BASE_URL: 'http://127.0.0.1:3210', RERUN_API_KEY: 'b'.repeat(64), RERUN_DATA_DIR: '/desktop-test/workspaces/1/engine' }) }))
vi.mock('../../datadir/ladder.js', () => ({ prepareDataDir: mocks.prepare }))
vi.mock('../../runtime/reconcile.js', () => ({ reconcileInterruptedRuns: mocks.reconcile }))
vi.mock('../../runtime/run-control.js', () => ({ abortAllRuns: mocks.abort }))
vi.mock('../../tools/mcp-pool.js', () => ({ closeAllMcp: mocks.closeMcp }))
vi.mock('../../desktop/mcp-tools.js', () => ({ stopDesktopMcp: mocks.mcp }))
vi.mock('../../desktop/schedule-binding.js', () => ({ bindDesktopSchedules: mocks.bind }))
vi.mock('../../runtime/scheduler.js', () => ({ startScheduler: mocks.start }))
vi.mock('../../desktop/codex-login.js', () => ({ codexLoginAction: vi.fn(), codexLoginStatus: vi.fn(), stopCodexLogin: vi.fn() }))
vi.mock('../../desktop/policy.js', () => ({ desktopApp: () => true, desktopRouteAllowed: () => true }))
vi.mock('../../lib/logger.js', () => ({ logger: { error: vi.fn() } }))
vi.mock('../../http/server.js', async () => {
    const { Hono } = await import('hono')
    return { createServer: () => new Hono().get('/agents/owner/sessions/session', c => c.json({ id: 'session' })).post('/agents/owner/schedules/task/run', c => c.json({ launched: true })) }
})
import { desktopRunCommand } from './desktop-run.js'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
let listener: () => void
let fetchApp: (request: Request) => Response | Promise<Response>
beforeEach(() => {
    vi.clearAllMocks(); mocks.events.clear()
    mocks.read.mockResolvedValue(JSON.stringify(runtime))
    mocks.reconcile.mockResolvedValue(undefined); mocks.bind.mockResolvedValue({ close: mocks.bindingClose })
    mocks.start.mockImplementation(() => Object.assign(mocks.stop, { drain: mocks.drain }))
    mocks.abort.mockResolvedValue(undefined); mocks.drain.mockResolvedValue(undefined); mocks.bindingClose.mockResolvedValue(undefined); mocks.mcp.mockResolvedValue(undefined)
    mocks.close.mockImplementation((done: () => void) => done())
    mocks.serve.mockImplementation((options: { fetch: typeof fetchApp }, ready: () => void) => { fetchApp = options.fetch; listener = ready; return { close: mocks.close, closeAllConnections: vi.fn() } })
    vi.stubGlobal('process', { ...process, env: { ...process.env, RERUN_DESKTOP_RUNTIME_FILE: '/desktop-test/runtime.json', RERUN_DESKTOP_SECRET_KEY: 'c'.repeat(64) },
        send: mocks.send, exit: mocks.exit, on: (name: string, handler: (...args: unknown[]) => void) => { mocks.events.set(name, handler) }, once: (name: string, handler: (...args: unknown[]) => void) => { mocks.events.set(name, handler) } })
})
afterEach(() => { vi.unstubAllGlobals() })
const request = (path: string, method = 'GET') => fetchApp(new Request(`http://127.0.0.1:3222${path}`, { method, headers: { Host: '127.0.0.1:3222', Authorization: `Bearer ${'b'.repeat(64)}` } }))

test('serves adoption reads during reconciliation but withholds writes, scheduler and readiness until bindings finish', async () => {
    const reconciled = deferred<void>(), bound = deferred<{ close: typeof mocks.bindingClose }>()
    mocks.reconcile.mockImplementation(() => reconciled.promise); mocks.bind.mockImplementation(() => bound.promise)
    await desktopRunCommand()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    listener()
    expect((await request('/agents/owner/sessions/session')).status).toBe(200)
    expect((await request('/health')).status).toBe(503)
    expect((await request('/agents/owner/schedules/task/run', 'POST')).status).toBe(503)
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
    reconciled.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(mocks.bind).toHaveBeenCalledOnce()
    expect(mocks.start).not.toHaveBeenCalled()
    bound.resolve({ close: mocks.bindingClose }); await Promise.resolve(); await Promise.resolve()
    expect((await request('/health')).status).toBe(200)
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
})

test('closes admission and aborts model preparation before waiting for scheduler drain', async () => {
    await desktopRunCommand(); listener()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const preparation = deferred<void>(), order: string[] = []
    mocks.stop.mockImplementation(() => { order.push('stop') })
    mocks.bindingClose.mockImplementation(async () => { order.push('close') })
    mocks.drain.mockImplementation(() => { order.push('drain'); return preparation.promise })
    mocks.abort.mockImplementation(async () => { order.push('abort'); preparation.resolve() })
    mocks.events.get('message')!({ type: 'stop' })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(order[0]).toBe('stop')
    expect(order.indexOf('abort')).toBeLessThan(order.indexOf('drain'))
    expect(mocks.abort).toHaveBeenCalledTimes(2)
    expect(mocks.exit).toHaveBeenCalledWith(0)
    expect((await request('/agents/owner/schedules/task/run', 'POST')).status).toBe(503)
})
