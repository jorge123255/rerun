import type { Client } from '@libsql/client'
import { beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from './runtime'

const state = vi.hoisted(() => ({ owner: 'local-owner', enabled: 1, deleting: null as null | string, getAgent: vi.fn(), adopt: vi.fn(), execute: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/engine/client', () => ({ getAgent: state.getAgent }))
vi.mock('./database', () => ({ openDesktopDatabase: async () => ({ execute: state.execute }) }))
vi.mock('./settings', () => ({ engineOf: () => ({ baseUrl: 'http://127.0.0.1:3222', apiKey: 'test' }) }))
vi.mock('./roster-writes', () => ({ withRosterWrite: (run: () => unknown) => run() }))
vi.mock('./schedules/adoption', () => ({ adoptDesktopScheduleEvent: state.adopt }))
vi.mock('./schedules/api', () => ({ desktopSchedulesApi: vi.fn() }))
import { authorizeDesktopSchedules, handleDesktopScheduleBridge } from './schedules-binding'
const db = { execute: state.execute } as unknown as Client
const runtime = { protocolVersion: 1, launchNonce: 'schedule-test', buildId: 'test', workspaceId: 1, dataRoot: '/schedule-ui', app: { origin: 'http://127.0.0.1:3210', sessionToken: 'unused' }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'test' } } as DesktopRuntime
const allowed = () => ({ id: 'engine-owner', config: { enabled: true, tools: { desktopToolGrants: { schedule: true } } } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
beforeEach(() => {
    vi.clearAllMocks()
    const globals = globalThis as typeof globalThis & { [key: symbol]: Set<string> | undefined }
    globals[Symbol.for('rerun.desktop.schedule.closed.v1')]?.clear()
    state.owner = 'local-owner'; state.enabled = 1; state.deleting = null
    state.execute.mockImplementation(async () => ({ rows: [{ id: state.owner, enabled: state.enabled, deleting: state.deleting }] }))
    state.getAgent.mockImplementation(async () => allowed())
    state.adopt.mockResolvedValue({ sessionId: 'local-session' })
})

test.each(['disabled', 'deleting', 'wrong-engine', 'missing-grant'] as const)('rejects current %s before adopting a scheduled conversation', async condition => {
    if (condition === 'disabled') state.enabled = 0
    if (condition === 'deleting') state.deleting = 'local-owner'
    if (condition === 'wrong-engine') state.getAgent.mockResolvedValue({ ...allowed(), id: 'sibling' })
    if (condition === 'missing-grant') state.getAgent.mockResolvedValue({ ...allowed(), config: { enabled: true, tools: { desktopToolGrants: {} } } })
    await expect(handleDesktopScheduleBridge(runtime, { event: 'desktop.schedule.adopt', agentId: 'engine-owner', sessionId: 'engine-session', runId: null, title: 'Routine' })).rejects.toThrow()
    expect(state.adopt).not.toHaveBeenCalled()
})

test('rechecks local owner after a delayed engine grant read', async () => {
    const pending = deferred<ReturnType<typeof allowed>>(), entered = deferred<void>()
    state.getAgent.mockImplementationOnce(() => { entered.resolve(); return pending.promise })
    const authorization = authorizeDesktopSchedules(runtime, db, 'engine-owner'), refused = expect(authorization).rejects.toThrow('identity changed')
    await entered.promise
    state.owner = 'replacement-owner'; pending.resolve(allowed())
    await refused
})

test('adoption waits for persistence and a shutdown during that wait prevents an acknowledgement', async () => {
    const pending = deferred<unknown>(), entered = deferred<void>()
    state.adopt.mockImplementationOnce(() => { entered.resolve(); return pending.promise })
    const adoption = handleDesktopScheduleBridge(runtime, { event: 'desktop.schedule.adopt', agentId: 'engine-owner', sessionId: 'engine-session', runId: null, title: 'Routine' })
    const refused = expect(adoption).rejects.toThrow('stopping')
    await entered.promise
    expect((await handleDesktopScheduleBridge(runtime, { event: 'desktop.schedule.shutdown' }))?.status).toBe(200)
    pending.resolve({ sessionId: 'local-session' })
    await refused
    // A separately loaded Next route bundle shares the same terminal launch state.
    vi.resetModules()
    const otherRoute = await import('./schedules-binding')
    await expect(otherRoute.authorizeDesktopSchedules(runtime, db, 'engine-owner')).rejects.toThrow('stopping')
})

test('successful adoption acknowledges only a durable, exact owned local chat', async () => {
    const event = { event: 'desktop.schedule.adopt', agentId: 'engine-owner', sessionId: 'engine-session', runId: 'engine-run', title: 'Routine' }
    const response = await handleDesktopScheduleBridge(runtime, event)
    expect(await response?.json()).toEqual({ ok: true, persisted: true })
    expect(state.adopt).toHaveBeenCalledWith(expect.anything(), expect.anything(), event)
    expect(state.getAgent).toHaveBeenCalledTimes(2)
})
