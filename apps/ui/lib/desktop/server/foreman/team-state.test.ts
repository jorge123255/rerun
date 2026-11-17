import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const getAgent = vi.fn()
const readDesktopSetupView = vi.fn()
const listDesktopAgents = vi.fn()
vi.mock('@/lib/engine/client', () => ({ getAgent: (...args: unknown[]) => getAgent(...args) }))
vi.mock('../settings', () => ({ engineOf: () => ({ url: 'http://127.0.0.1:1', apiKey: 'engine-key' }) }))
vi.mock('../setup/service', () => ({ readDesktopSetupView: (...args: unknown[]) => readDesktopSetupView(...args) }))
vi.mock('../store', () => ({ listDesktopAgents: (...args: unknown[]) => listDesktopAgents(...args) }))

const { readDesktopTeamState, DESKTOP_TEAM_STATE_LIMIT } = await import('./team-state')
const { desktopTeamChangesInstruction } = await import('./team-changes-binding')

const agent = (id: string, name: string, enabled = true) => ({ id, name, enabled, engineAgentId: `engine-${id}` })
const config = (extra: Record<string, unknown> = {}) => ({ config: { connectionId: 'c1', model: 'gpt-6-sol', tools: { desktopWorkspaceRead: true, desktopToolGrants: { callAgent: true, webSearch: true, guestShell: true } }, ...extra } })
const setup = (extra: Record<string, unknown> = {}) => ({ required: true, prompt: 'Install your tools.', completedAt: null, sessionId: null, skipped: false, ...extra })
const connections = [{ id: 'c1', name: 'ChatGPT (Codex)' }]
const runtime = {} as never, db = {} as never

beforeEach(() => { getAgent.mockReset(); readDesktopSetupView.mockReset(); listDesktopAgents.mockReset() })
afterEach(() => { vi.useRealTimers() })

test('each coworker carries its model, the nameable permissions it has, and where its setup stands', async () => {
    listDesktopAgents.mockResolvedValue([agent('a', 'Ada'), agent('b', 'Ben', false), agent('c', 'Cy'), agent('d', 'Di')])
    getAgent.mockImplementation(async (_engine: unknown, id: string) => id === 'engine-b' ? config({ connectionId: null, model: null, tools: { desktopToolGrants: {} } }) : config())
    readDesktopSetupView.mockImplementation(async (_runtime: unknown, id: string) => id === 'a' ? setup() : id === 'b' ? setup({ sessionId: 's1' }) : id === 'c' ? setup({ completedAt: '2026-11-17T00:00:00Z' }) : setup({ required: false, prompt: '' }))

    const state = await readDesktopTeamState(runtime, db, connections)
    expect(state).toEqual([
        // guestShell reaches the Mac, so it is not a permission a proposal may name and is not listed.
        { name: 'Ada', on: true, model: 'ChatGPT (Codex) · gpt-6-sol', allowed: ['callAgent', 'webSearch'], setup: 'needed' },
        { name: 'Ben', on: false, model: null, allowed: [], setup: 'started' },
        { name: 'Cy', on: true, model: 'ChatGPT (Codex) · gpt-6-sol', allowed: ['callAgent', 'webSearch'], setup: 'done' },
        { name: 'Di', on: true, model: 'ChatGPT (Codex) · gpt-6-sol', allowed: ['callAgent', 'webSearch'], setup: 'none' },
    ])
})

test('a coworker the engine cannot answer for keeps its name and switch, and the others are still read', async () => {
    listDesktopAgents.mockResolvedValue([agent('a', 'Ada'), agent('b', 'Ben')])
    getAgent.mockImplementation(async (_engine: unknown, id: string) => { if (id === 'engine-a') throw new Error('engine down'); return config() })
    readDesktopSetupView.mockRejectedValue(new Error('no setup'))

    expect(await readDesktopTeamState(runtime, db, connections)).toEqual([
        { name: 'Ada', on: true, model: null, allowed: null, setup: 'unknown' },
        { name: 'Ben', on: true, model: 'ChatGPT (Codex) · gpt-6-sol', allowed: ['callAgent', 'webSearch'], setup: 'unknown' },
    ])
})

test('a read that hangs does not hold the Chief of Staff\'s turn', async () => {
    vi.useFakeTimers()
    listDesktopAgents.mockResolvedValue([agent('a', 'Ada')])
    getAgent.mockReturnValue(new Promise(() => {}))
    readDesktopSetupView.mockReturnValue(new Promise(() => {}))
    const pending = readDesktopTeamState(runtime, db, connections)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual([{ name: 'Ada', on: true, model: null, allowed: null, setup: 'unknown' }])
})

test('no more coworkers are read than the limit', async () => {
    listDesktopAgents.mockResolvedValue(Array.from({ length: DESKTOP_TEAM_STATE_LIMIT + 5 }, (_, i) => agent(`a${i}`, `Coworker ${i}`)))
    getAgent.mockResolvedValue(config()); readDesktopSetupView.mockResolvedValue(setup())
    expect(await readDesktopTeamState(runtime, db, connections)).toHaveLength(DESKTOP_TEAM_STATE_LIMIT)
    expect(getAgent).toHaveBeenCalledTimes(DESKTOP_TEAM_STATE_LIMIT)
})

test('the Chief of Staff is told the settings as they are and how to run the setup conversation, with no key or address', () => {
    const text = desktopTeamChangesInstruction(
        [{ connectionId: 'c1', name: 'ChatGPT (Codex)', models: [{ id: 'gpt-6-sol', efforts: ['low', 'high'] }] }],
        [
            { name: 'Ada', on: true, model: 'ChatGPT (Codex) · gpt-6-sol', allowed: ['callAgent'], setup: 'needed' },
            { name: 'Ben', on: false, model: null, allowed: [], setup: 'none' },
            { name: 'Cy', on: true, model: null, allowed: null, setup: 'unknown' },
        ],
    )
    expect(text).toContain('{"name":"Ada","on":true,"model":"ChatGPT (Codex) · gpt-6-sol","allowed":["callAgent"],"setup":"needed"}')
    // Read, and following the workspace default; not read at all says nothing about model or permissions.
    expect(text).toContain('{"name":"Ben","on":false,"model":"workspace default","allowed":[],"setup":"not needed"}')
    expect(text).toContain('{"name":"Cy","on":true}')
    expect(text).toContain('The setup conversation.')
    expect(text).toContain('settle this before any start_setup')
    expect(text).toContain('Never propose start_setup for a coworker whose setup is not needed')
    expect(text).toContain('never a line for something already so')
    expect(text).toContain('are not yours to propose')
    expect(text).not.toContain('engine-key')
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain('c1')
})
