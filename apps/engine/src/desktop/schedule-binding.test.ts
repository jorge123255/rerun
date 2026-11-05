import { beforeEach, afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getAgent: vi.fn(), list: vi.fn(), ddl: vi.fn(), recover: vi.fn(), configure: vi.fn(), release: vi.fn(), deleting: vi.fn(),
}))
vi.mock('../agents/registry.js', () => ({ getAgent: mocks.getAgent }))
vi.mock('../agents/loader.js', () => ({ listAgentIdsOnDisk: mocks.list }))
vi.mock('../config/paths.js', () => ({ dataDir: () => '/schedule-engine' }))
vi.mock('../db/systemDb.js', () => ({ getSystemDb: async () => ({ client: { executeMultiple: mocks.ddl } }) }))
vi.mock('../runtime/desktop-schedule-state.js', () => ({ desktopScheduleOccurrenceSchema: 'schedule schema', recoverDesktopScheduleClaims: mocks.recover }))
vi.mock('../runtime/scheduler.js', () => ({ configureDesktopSchedules: mocks.configure }))
vi.mock('./agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => mocks.release, desktopDeletionPending: mocks.deleting }))
const runtime = { app: { origin: 'http://127.0.0.1:3210' }, engine: { apiKey: 'private-test-key' } }
const granted = (id: string) => ({ id, config: { enabled: true, tools: { desktopToolGrants: { schedule: true } } } })
const ok = () => Response.json({ ok: true, persisted: true })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.getAgent.mockImplementation(async id => granted(id))
    mocks.list.mockResolvedValue(['owner'])
    mocks.deleting.mockReturnValue(false)
    mocks.ddl.mockResolvedValue(undefined); mocks.recover.mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn(async () => ok()))
})
afterEach(() => { vi.unstubAllGlobals() })

test('initializes every current owner before configuration; new owner initializes once before admission', async () => {
    mocks.list.mockResolvedValue(['owner', 'other', 'deleting'])
    mocks.deleting.mockImplementation(id => id === 'deleting')
    const binding = await import('./schedule-binding.js')
    const service = await binding.bindDesktopSchedules(runtime)
    expect(mocks.recover.mock.calls.map(call => call[0])).toEqual(['owner', 'other'])
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.configure).toHaveBeenCalledOnce()
    await service.authorize('new-owner'); await service.authorize('new-owner')
    expect(mocks.recover.mock.calls.filter(call => call[0] === 'new-owner')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3210/api/webhooks/engine', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer private-test-key' }) }))
})

test('an acknowledgement is insufficient if the exact engine owner lost its grant while waiting', async () => {
    const { bindDesktopSchedules } = await import('./schedule-binding.js')
    const service = await bindDesktopSchedules(runtime)
    const response = deferred<Response>(), entered = deferred<void>()
    vi.mocked(fetch).mockImplementationOnce(async () => { entered.resolve(); return response.promise })
    const pending = service.authorize('owner')
    const refused = expect(pending).rejects.toThrow('disabled')
    await entered.promise
    mocks.getAgent.mockResolvedValue({ ...granted('owner'), config: { enabled: true, tools: { desktopToolGrants: { schedule: false } } } })
    response.resolve(ok())
    await refused
})

test('shutdown aborts a stalled acknowledgement reader and permanently closes this binding', async () => {
    const { bindDesktopSchedules } = await import('./schedule-binding.js')
    const service = await bindDesktopSchedules(runtime)
    const entered = deferred<void>(), read = deferred<ReadableStreamReadResult<Uint8Array>>()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: true, body: { getReader: () => ({ read: () => { entered.resolve(); return read.promise }, cancel }) } }) as unknown as Response)
    const pending = service.authorize('owner'), refused = expect(pending).rejects.toBeDefined()
    await entered.promise
    await service.close()
    await refused
    expect(cancel).toHaveBeenCalledOnce()
    await expect(service.authorize('owner')).rejects.toThrow('stopping')
    read.resolve({ done: true, value: undefined })
    await Promise.resolve()
})

test('adoption requires an explicit durable acknowledgement before it can finish', async () => {
    const { bindDesktopSchedules } = await import('./schedule-binding.js')
    await bindDesktopSchedules(runtime)
    const hooks = mocks.configure.mock.calls[0][0] as { adopt: (owner: string, session: string, run: string | null, title: string) => Promise<void> }
    vi.mocked(fetch).mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).event === 'desktop.schedule.adopt' ? Response.json({ ok: true, persisted: false }) : ok())
    await expect(hooks.adopt('owner', 'engine-session', null, 'Routine result')).rejects.toThrow()
    expect(vi.mocked(fetch).mock.calls.map(call => JSON.parse(String(call[1]?.body)).event)).toEqual(['desktop.schedule.authorize', 'desktop.schedule.adopt'])
})
