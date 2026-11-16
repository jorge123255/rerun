import type { Client } from '@libsql/client'
import { beforeEach, expect, test, vi } from 'vitest'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'

const state = vi.hoisted(() => ({ owner: 'local-owner', enabled: 1, deleting: null as null | string, getAgent: vi.fn(), adopt: vi.fn(), execute: vi.fn(), preset: vi.fn(), connections: [] as unknown[], backup: null as null | { connection_id: string; model: string },
    PresetUnavailable: null as unknown as new (message: string, tier: string) => Error }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/engine/client', () => ({ getAgent: state.getAgent }))
vi.mock('./database', () => ({ openDesktopDatabase: async () => ({ execute: state.execute }) }))
vi.mock('./settings', () => ({ engineOf: () => ({ baseUrl: 'http://127.0.0.1:3222', apiKey: 'test' }), readDesktopProviders: async () => ({ connections: state.connections }) }))
vi.mock('./roster-writes', () => ({ withRosterWrite: (run: () => unknown) => run() }))
vi.mock('./schedules/adoption', () => ({ adoptDesktopScheduleEvent: state.adopt }))
vi.mock('./chat-model', async () => {
    const { DesktopHttpError: HttpError } = await import('./auth')
    state.PresetUnavailable = class extends HttpError { constructor(message: string, readonly tier: string) { super(409, message) } }
    return { resolveDesktopRoutinePreset: state.preset, PresetUnavailable: state.PresetUnavailable }
})
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
    state.connections = []; state.backup = null
    state.execute.mockImplementation(async (query: unknown) => String(typeof query === 'string' ? query : (query as { sql: string }).sql).includes('desktop_usage_backup_model')
        ? { rows: state.backup ? [state.backup] : [] } : { rows: [{ id: state.owner, enabled: state.enabled, deleting: state.deleting }] })
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

test('a routine is told the plan its Rerun preset means now, or nothing when no preset decides it', async () => {
    state.preset.mockResolvedValueOnce({ connectionId: 'mac-chatgpt', model: 'gpt-6-luna' })
    const event = { event: 'desktop.schedule.model', agentId: 'engine-owner' }
    expect(await (await handleDesktopScheduleBridge(runtime, event))?.json()).toEqual({ ok: true, persisted: true, model: { connectionId: 'mac-chatgpt', model: 'gpt-6-luna' } })
    expect(state.preset).toHaveBeenCalledWith(runtime, 'engine-owner')
    state.preset.mockResolvedValueOnce(null)
    expect(await (await handleDesktopScheduleBridge(runtime, event))?.json()).toEqual({ ok: true, persisted: true, model: null })
})

test('a preset with no plan left is reported in words, and a coworker without the grant is still refused', async () => {
    state.preset.mockRejectedValueOnce(new DesktopHttpError(409, 'Rerun Fast has no plan with usage left (Claude).'))
    const event = { event: 'desktop.schedule.model', agentId: 'engine-owner' }
    expect(await (await handleDesktopScheduleBridge(runtime, event))?.json()).toEqual({ ok: true, persisted: true, model: null, unavailable: 'Rerun Fast has no plan with usage left (Claude).' })
    state.getAgent.mockResolvedValue({ ...allowed(), config: { enabled: true, tools: { desktopToolGrants: {} } } })
    await expect(handleDesktopScheduleBridge(runtime, event)).rejects.toThrow()
    expect(state.preset).toHaveBeenCalledTimes(1)
})

const plan = (extra: Record<string, unknown> = {}) => ({ id: 'mac-chatgpt', name: 'ChatGPT', provider: 'codex', connected: true, credentialRejected: false, models: ['gpt-6-sol'], extraModels: [],
    planLimits: { capturedAt: '2026-11-16T10:00:00.000Z', windows: [{ kind: 'session', label: null, usedPercent: 100, resetsAt: '2999-01-01T00:00:00.000Z' }] }, ...extra })
const key = { id: 'openai-key', name: 'OpenAI', provider: 'openai', connected: true, credentialRejected: false, models: ['gpt-paid'], extraModels: [], planLimits: null }

test('a preset whose plan is out of usage tells the engine which plan to wait for, and when it resets', async () => {
    state.connections = [plan(), key]
    state.preset.mockRejectedValueOnce(new state.PresetUnavailable('Rerun Smart has no plan with usage left (ChatGPT).', 'smart'))
    const answer = await (await handleDesktopScheduleBridge(runtime, { event: 'desktop.schedule.model', agentId: 'engine-owner' }))?.json()
    // The key is connected, and is not offered: nothing moves to a paid key on its own.
    expect(answer).toEqual({ ok: true, persisted: true, model: null, unavailable: 'Rerun Smart has no plan with usage left (ChatGPT).',
        waiting: { connectionId: 'mac-chatgpt', plan: 'ChatGPT', provider: 'codex', resetsAt: '2999-01-01T00:00:00.000Z' } })
})

test('the backup model the owner picked runs a routine whose preset or plan is out of usage', async () => {
    state.connections = [plan(), key]
    state.backup = { connection_id: 'openai-key', model: 'gpt-paid' }
    state.preset.mockRejectedValueOnce(new state.PresetUnavailable('Rerun Smart has no plan with usage left (ChatGPT).', 'smart'))
    expect(await (await handleDesktopScheduleBridge(runtime, { event: 'desktop.schedule.model', agentId: 'engine-owner' }))?.json())
        .toEqual({ ok: true, persisted: true, model: { connectionId: 'openai-key', model: 'gpt-paid' } })
    expect(await (await handleDesktopScheduleBridge(runtime, { event: 'desktop.schedule.backup', agentId: 'engine-owner', outConnectionId: 'mac-chatgpt' }))?.json())
        .toEqual({ ok: true, persisted: true, model: { connectionId: 'openai-key', model: 'gpt-paid', note: 'Backup model is answering on OpenAI · gpt-paid: ChatGPT is out of usage.' } })
})

test('with no backup picked, the backup question is answered with nothing even when a paid key is connected', async () => {
    state.connections = [plan(), key]
    expect(await (await handleDesktopScheduleBridge(runtime, { event: 'desktop.schedule.backup', agentId: 'engine-owner', outConnectionId: 'mac-chatgpt' }))?.json())
        .toEqual({ ok: true, persisted: true, model: null })
})
