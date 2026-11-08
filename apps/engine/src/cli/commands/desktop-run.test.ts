import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const runtime = { protocolVersion: 1, launchNonce: 'c1111111-1111-4111-8111-111111111111', buildId: 'test', workspaceId: 1, dataRoot: '/desktop-test', app: { origin: 'http://127.0.0.1:3210', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'b'.repeat(64) } }
const mocks = vi.hoisted(() => ({
    read: vi.fn(), serve: vi.fn(), prepare: vi.fn(), reconcile: vi.fn(), bind: vi.fn(), start: vi.fn(), abort: vi.fn(), mcp: vi.fn(), closeMcp: vi.fn(),
    send: vi.fn(), exit: vi.fn(), close: vi.fn(), drain: vi.fn(), stop: vi.fn(), bindingClose: vi.fn(), events: new Map<string, (...args: unknown[]) => void>(),
    engineDir: '/desktop-test/workspaces/1/engine', brain: vi.fn(), brief: vi.fn(), recover: vi.fn(), nativeDrain: vi.fn(), externalInit: vi.fn(), externalClose: vi.fn(), externalDispatch: vi.fn(),
}))
// Each command fixture represents a fresh engine process; isolate the process-owned dispatch registry.
vi.mock('../../desktop/external-mcp-authority/dispatch.js', () => ({ registerExternalMcpDispatch: mocks.externalDispatch }))
vi.mock('../../desktop/external-mcp-authority/runtime.js', () => ({ initializeDesktopExternalMcp: mocks.externalInit,closeDesktopExternalMcp: mocks.externalClose,getExternalMcpService: () => ({ close: mocks.externalClose,recheck: vi.fn(async () => ({ ok: false })) }) }))
vi.mock('../../agents/foreman.js', () => ({ ensureForeman: vi.fn(async () => {}) }))
vi.mock('../../desktop/claude-plan/auth.js', () => ({ bindDesktopClaudePlanAuth: () => ({ status: vi.fn(), action: vi.fn(), stop: vi.fn() }) }))
vi.mock('../../desktop/claude-plan/runtime.js', () => ({ stopDesktopClaudeWorkers: vi.fn(async () => {}) }))
vi.mock('../../desktop/guest-shell/runtime.js', () => ({ bindDesktopGuestShell: () => ({ close: vi.fn(async () => {}) }) }))
vi.mock('../../desktop/custom-providers/binding.js', async () => {
    const { Hono } = await import('hono')
    return { bindDesktopCustomProviders: () => ({ routes: new Hono(), abort: vi.fn(), close: vi.fn() }), desktopCustomProviderBinding: () => undefined }
})
vi.mock('../../desktop/foreman/binding.js', () => ({ bindDesktopForeman: () => ({ close: vi.fn() }) }))
vi.mock('../../desktop/foreman/routes.js', async () => { const { Hono } = await import('hono'); return { createDesktopForemanRoutes: () => new Hono() } })
vi.mock('../../desktop/tool-install/binding.js', async () => { const { Hono } = await import('hono'); return { bindDesktopToolInstall: () => ({ routes: new Hono(), close: vi.fn(async () => {}) }) } })
vi.mock('../../desktop/computer-panel/binding.js', async () => { const { Hono } = await import('hono'); return { bindDesktopComputerPanel: () => ({ routes: new Hono(), close: vi.fn() }) } })
vi.mock('../../desktop/trigger-tools/runtime.js', () => ({ createDesktopTriggerToolRuntime: vi.fn(() => ({ close: vi.fn(async () => {}) })) }))
vi.mock('../../desktop/schedule-tools/runtime.js', () => ({ createDesktopScheduleToolRuntime: vi.fn(async () => ({ close: vi.fn(async () => {}) })) }))
vi.mock('node:fs/promises', () => ({ readFile: mocks.read, realpath: async (path: string) => path,
    writeFile: vi.fn(async () => {}), rename: vi.fn(async () => {}), rm: vi.fn(async () => {}),
}))
vi.mock('@hono/node-server', () => ({ serve: mocks.serve }))
vi.mock('../../config/env.js', () => ({ env: () => ({ RERUN_HOST: '127.0.0.1', RERUN_PORT: 3222, RERUN_HUB_BASE_URL: 'http://127.0.0.1:3210', RERUN_API_KEY: 'b'.repeat(64), RERUN_DATA_DIR: mocks.engineDir }) }))
vi.mock('../../desktop/isolated-screen/binding.js', async () => { const { Hono } = await import('hono'); return { bindIsolatedScreen: () => ({ routes: new Hono(), attach: vi.fn(), close: vi.fn(async () => {}) }) } })
vi.mock('../../desktop/isolated-screen/index.js', () => ({ reconcileIsolatedScreens: vi.fn(async () => {}), shutdownIsolatedScreens: vi.fn(async () => {}) }))
vi.mock('../../desktop/delegation/binding.js', async () => { const { Hono } = await import('hono'); return { bindDesktopDelegation: () => ({ routes: new Hono(), initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) }), installDesktopDelegation: vi.fn() } })
vi.mock('../../desktop/coworker-calls/bind.js', () => ({ bindDesktopCoworkerCalls: vi.fn(async () => {}) }))
vi.mock('../../desktop/triggers/runtime.js', () => ({ createDesktopTriggerRuntime: vi.fn(async () => ({ close: vi.fn(async () => {}) })), readDesktopTriggerRuntime: () => undefined }))
vi.mock('../../desktop/triggers/router.js', async () => { const { Hono } = await import('hono'); return { createDesktopTriggerRoutes: () => new Hono() } })
vi.mock('../../desktop/computer-launchers/sqlite-store.js', () => ({ initializeComputerLaunchers: vi.fn(async () => {}) }))
vi.mock('../../desktop/semantic-memory/runtime.js', () => ({ shutdownDesktopSemanticMemory: vi.fn(async () => {}) }))
vi.mock('../../datadir/ladder.js', () => ({ prepareDataDir: mocks.prepare }))
vi.mock('../../runtime/reconcile.js', () => ({ reconcileInterruptedRuns: mocks.reconcile }))
vi.mock('../../runtime/run-control.js', () => ({ abortAllRuns: mocks.abort }))
vi.mock('../../tools/mcp-pool.js', () => ({ closeAllMcp: mocks.closeMcp }))
vi.mock('../../desktop/mcp-tools.js', () => ({ stopDesktopMcp: mocks.mcp }))
vi.mock('../../desktop/brain-pages-router.js',()=>({initializeDesktopBrainStore:mocks.brain}))
vi.mock('../../desktop/company-brief/runtime.js',()=>({initializeDesktopCompanyBriefStore:mocks.brief}))
vi.mock('../../desktop/native-writeback/outbox.js',()=>({recoverNativeWritebackOutbox:mocks.recover}))
vi.mock('../../desktop/native-writeback/client.js',()=>({sendNativeWriteback:vi.fn()}))
vi.mock('../../desktop/native-worker.js',()=>({stopAllDesktopNativeWorkers:mocks.nativeDrain}))
vi.mock('../../desktop/skill-proposal-work.js',()=>({stopDesktopSkillProposals:vi.fn(async()=>{})}))
vi.mock('../../desktop/schedule-binding.js', () => ({ bindDesktopSchedules: mocks.bind }))
vi.mock('../../runtime/scheduler.js', () => ({ startScheduler: mocks.start }))
vi.mock('../../desktop/codex-login.js', () => ({ codexLoginAction: vi.fn(), codexLoginStatus: vi.fn(), stopCodexLogin: vi.fn() }))
vi.mock('../../desktop/policy.js', () => ({ desktopApp: () => true, desktopRouteAllowed: () => true }))
vi.mock('../../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock('../../http/server.js', async () => {
    const { Hono } = await import('hono')
    return { createServer: () => new Hono().get('/agents/owner/sessions/session', c => c.json({ id: 'session' })).post('/agents/owner/schedules/task/run', c => c.json({ launched: true })) }
})
import { desktopRunCommand } from './desktop-run.js'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
let listener: () => void
let fetchApp: (request: Request) => Response | Promise<Response>
beforeEach(() => {
    vi.clearAllMocks(); mocks.events.clear(); mocks.engineDir = '/desktop-test/workspaces/1/engine'
    mocks.read.mockImplementation(async (path: string) => String(path).endsWith('desktop-owner.json') ? JSON.stringify({ installId: 'd1111111-1111-4111-8111-111111111111', workspaceId: 1 }) : JSON.stringify(runtime))
    mocks.externalInit.mockResolvedValue(undefined); mocks.externalClose.mockResolvedValue(undefined)
    mocks.brain.mockResolvedValue(undefined);mocks.brief.mockResolvedValue(undefined);mocks.recover.mockResolvedValue({recovered:[],retained:[]});mocks.nativeDrain.mockResolvedValue(undefined)
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
    const reconciled = deferred<void>(), recovered=deferred<{recovered:string[];retained:string[]}>(), bound = deferred<{ close: typeof mocks.bindingClose }>()
    mocks.reconcile.mockImplementation(() => reconciled.promise); mocks.bind.mockImplementation(() => bound.promise)
    mocks.recover.mockImplementation(()=>recovered.promise)
    await desktopRunCommand()
    expect(mocks.externalInit).toHaveBeenCalledOnce()
    expect(mocks.externalDispatch).toHaveBeenCalledOnce()
    expect(mocks.brain).toHaveBeenCalledOnce()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    listener()
    expect((await request('/agents/owner/sessions/session')).status).toBe(200)
    expect((await request('/health')).status).toBe(503)
    expect((await request('/agents/owner/schedules/task/run', 'POST')).status).toBe(503)
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
    reconciled.resolve();await vi.waitFor(()=>expect(mocks.recover).toHaveBeenCalledOnce())
    expect(mocks.bind).not.toHaveBeenCalled()
    recovered.resolve({recovered:[],retained:[]});await vi.waitFor(()=>expect(mocks.bind).toHaveBeenCalledOnce())
    expect(mocks.start).not.toHaveBeenCalled()
    bound.resolve({ close: mocks.bindingClose });await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({type:'ready'})))
    expect((await request('/health')).status).toBe(200)
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
})

test('closes admission and aborts model preparation before waiting for scheduler drain', async () => {
    await desktopRunCommand(); listener()
    await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({type:'ready'})))
    const preparation = deferred<void>(), order: string[] = []
    mocks.stop.mockImplementation(() => { order.push('stop') })
    mocks.bindingClose.mockImplementation(async () => { order.push('close') })
    mocks.drain.mockImplementation(() => { order.push('drain'); return preparation.promise })
    mocks.abort.mockImplementation(async () => { order.push('abort'); preparation.resolve() })
    mocks.events.get('message')!({ type: 'stop' })
    await vi.waitFor(()=>expect(mocks.exit).toHaveBeenCalledWith(0))
    expect(order[0]).toBe('stop')
    expect(order.indexOf('abort')).toBeLessThan(order.indexOf('drain'))
    expect(mocks.abort).toHaveBeenCalledTimes(2)
    expect(mocks.exit).toHaveBeenCalledWith(0)
    expect((await request('/agents/owner/schedules/task/run', 'POST')).status).toBe(503)
})

test('reports an unconfirmed writer drain without releasing process custody and permits cleanup retry',async()=>{
    await desktopRunCommand();listener()
    await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({type:'ready'})))
    mocks.nativeDrain.mockRejectedValueOnce(new Error('writer exit unconfirmed')).mockResolvedValue(undefined)
    mocks.events.get('message')!({type:'stop'})
    await vi.waitFor(()=>expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({type:'stop-failed'})))
    expect(mocks.exit).not.toHaveBeenCalled()
    expect((await request('/agents/owner/schedules/task/run','POST')).status).toBe(503)
    mocks.events.get('message')!({type:'stop'})
    await vi.waitFor(()=>expect(mocks.exit).toHaveBeenCalledWith(0))
    expect(mocks.nativeDrain).toHaveBeenCalledTimes(2)
})

test('a lost terminal schedule notification does not prevent confirmed process cleanup', async () => {
    await desktopRunCommand(); listener()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })))
    mocks.bindingClose.mockRejectedValueOnce(new Error('UI notification unavailable'))
    mocks.events.get('message')!({ type: 'stop' })
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0))
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'stopped' }))
})


test('binds company brief before readiness on each launch of an already migrated workspace', async () => {
    const secondBinding = deferred<void>()
    await desktopRunCommand()
    expect(mocks.brief).toHaveBeenCalledOnce()
    listener()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })))
    mocks.events.get('message')!({ type: 'stop' })
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0))
    mocks.send.mockClear(); mocks.serve.mockClear()
    // prepareDataDir is already current and does not rerun any migration binding.
    mocks.prepare.mockResolvedValue(undefined)
    mocks.brief.mockImplementationOnce(() => secondBinding.promise)
    const reopened = desktopRunCommand()
    await vi.waitFor(() => expect(mocks.brief).toHaveBeenCalledTimes(2))
    expect(mocks.serve).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    secondBinding.resolve()
    await reopened; listener()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })))
})


test('refuses a nonlegacy workspace without its install identity before bootstrap', async () => {
    const target = { ...runtime, workspaceId: 2, dataRoot: '/desktop-test/workspaces/2', installRoot: '/desktop-test', engineRoot: '/desktop-test/workspaces/2/engine' }
    mocks.engineDir = target.engineRoot
    process.env.RERUN_DESKTOP_WORKSPACE_ID = '2'
    process.env.RERUN_DESKTOP_INSTALL_DIR = '/desktop-test'
    mocks.read.mockResolvedValue(JSON.stringify(target))
    await expect(desktopRunCommand()).rejects.toThrow('install identity is missing')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.brief).not.toHaveBeenCalled()
})


test('retains process custody when external MCP cleanup is unconfirmed and retries its same authority',async () => {
    await desktopRunCommand();listener()
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })))
    mocks.externalClose.mockRejectedValueOnce(new Error('External writer is still settling')).mockResolvedValue(undefined)
    mocks.events.get('message')!({ type: 'stop' })
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop-failed' })))
    expect(mocks.exit).not.toHaveBeenCalled()
    expect((await request('/agents/owner/schedules/task/run','POST')).status).toBe(503)
    mocks.events.get('message')!({ type: 'stop' })
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0))
    expect(mocks.externalClose).toHaveBeenCalledTimes(2)
})
