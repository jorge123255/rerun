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
const setup = (extra: Record<string, unknown> = {}) => ({ required: true, prompt: 'Install your tools.', completedAt: null, sessionId: null, skipped: false, pending: true, ...extra })
const connections = [{ id: 'c1', name: 'ChatGPT (Codex)' }]
const runtime = {} as never, db = {} as never

beforeEach(() => { getAgent.mockReset(); readDesktopSetupView.mockReset(); listDesktopAgents.mockReset() })
afterEach(() => { vi.useRealTimers() })

test('tells the Chief a skipped or retired setup chat no longer blocks work', async () => {
    listDesktopAgents.mockResolvedValue([agent('skipped', 'Ada'), agent('retired', 'Ben')])
    getAgent.mockResolvedValue(config())
    readDesktopSetupView.mockImplementation(async (_runtime: unknown, id: string) =>
        setup({ sessionId: 'saved-setup-chat', pending: false, skipped: id === 'skipped' }))
    const team = await readDesktopTeamState(runtime, db, connections)
    expect(team.map(person => person.setup)).toEqual(['skipped', 'none'])
    expect(desktopTeamChangesInstruction([], team, 12_000)).toContain('"setup":"skipped"')
})

test('each coworker carries its model, the nameable permissions it has, and where its setup stands', async () => {
    listDesktopAgents.mockResolvedValue([agent('a', 'Ada'), agent('b', 'Ben', false), agent('c', 'Cy'), agent('d', 'Di')])
    getAgent.mockImplementation(async (_engine: unknown, id: string) => id === 'engine-b' ? config({ connectionId: null, model: null, tools: { desktopToolGrants: {} } }) : config())
    readDesktopSetupView.mockImplementation(async (_runtime: unknown, id: string) => id === 'a' ? setup() : id === 'b' ? setup({ sessionId: 's1' }) : id === 'c' ? setup({ completedAt: '2026-11-17T00:00:00Z' }) : setup({ required: false, prompt: '', pending: false }))

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
    )!
    expect(text).toContain('{"name":"Ada","on":true,"model":"ChatGPT (Codex) · gpt-6-sol","allowed":["callAgent"],"setup":"needed"}')
    // Read, and following the workspace default; not read at all says nothing about model or permissions.
    expect(text).toContain('{"name":"Ben","on":false,"model":"workspace default","allowed":[],"setup":"not needed"}')
    expect(text).toContain('{"name":"Cy","on":true}')
    expect(text).toContain('The setup conversation.')
    expect(text).toContain('settle this before any start_setup')
    expect(text).toContain('Never propose start_setup for a coworker whose setup is not needed')
    expect(text).toContain('inspect_coworker_setup')
    expect(text).toContain('reply_setup')
    expect(text).toContain('continue_setup')
    expect(text).toContain('skip_setup only when the person explicitly asks')
    expect(text).toContain('stepId')
    expect(text).toContain('masked form')
    expect(text).toContain('Open setup for that coworker')
    expect(text).toContain('never a line for something already so')
    expect(text).toContain('are not yours to propose')
    expect(text).not.toContain('engine-key')
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain('c1')
})

test('who each coworker and the Chief of Staff may ask comes from the app\'s own list', async () => {
    const { readDesktopChiefAsks } = await import('./team-state')
    listDesktopAgents.mockResolvedValue([agent('a', 'Ada'), agent('b', 'Ben'), agent('c', 'Cy')])
    getAgent.mockResolvedValue(config()); readDesktopSetupView.mockResolvedValue(setup())
    const rows = [['a', 'b'], ['a', 'c'], ['b', 'a'], ['foreman', 'c']].map(([caller, target]) => ({ caller_agent_id: caller, target_agent_id: target }))
    const listed = { execute: vi.fn(async () => ({ rows })) } as never
    expect((await readDesktopTeamState(runtime, listed, connections)).map(state => [state.name, state.asks])).toEqual([['Ada', 'everyone'], ['Ben', ['Ada']], ['Cy', []]])
    expect(await readDesktopChiefAsks(listed)).toEqual(['Cy'])
    // A list that cannot be read says nothing, rather than "nobody".
    const broken = { execute: vi.fn(async () => { throw new Error('no table') }) } as never
    expect((await readDesktopTeamState(runtime, broken, connections))[0].asks).toBeUndefined()
    expect(await readDesktopChiefAsks(broken)).toBeNull()
})

test('the Chief of Staff is told who may ask whom and to propose both halves of working together', () => {
    const text = desktopTeamChangesInstruction([], [{ name: 'Ada', on: true, model: null, allowed: ['callAgent'], setup: 'none', asks: [] }], 12_000, ['Ben'])!
    expect(text).toContain('"allowed":["callAgent"],"asks":[]')
    expect(text).toContain('The permission alone lets a coworker ask nobody')
    expect(text).toContain('Who you yourself may message with call_agent (data): ["Ben"]')
    expect(desktopTeamChangesInstruction([], [], 12_000)).not.toContain('Who you yourself may message')
})

// The person's rule for team access: the Chief of Staff may message every coworker that is on;
// each coworker may ask only those on its own or a linked GitHub repository, or, without a
// repository, those in its Box. The app works out who that is; the card still asks the person.
test('each coworker carries its repository, the linked repositories and its teammates under the person\'s rule', async () => {
    const project = (id: string, removed = false) => {
        const [owner, name] = id.split('/') as [string, string]
        return { id, owner, name, url: `https://github.com/${id}`, state: 'read', failure: null, kind: 'other', kindSource: 'default', purpose: null, stack: [], build: null, suggestedRoles: [], roles: [], removed }
    }
    const record = (projects: ReturnType<typeof project>[], links: [string, string][]) => JSON.stringify({ key: 'f'.repeat(64), revision: 0, inference: 'none', inferenceNote: null, projects,
        links: links.map(([from, to]) => ({ from, to, kind: 'depends-on', source: 'owner', quote: null })), readAt: 'now', updatedAt: 'now' })
    const fakeDb = {
        execute: async (query: string | { sql: string; args: unknown[] }) => {
            const sql = typeof query === 'string' ? query : query.sql
            if (sql.includes('desktop_coworker_call_allows')) return { rows: [] }
            if (sql.includes('desktop_space_placements')) return { rows: [{ agent_id: 'of', name: 'OpenFlix' }, { agent_id: 'w', name: 'OpenFlix' }, { agent_id: 't', name: 'OpenFlix' }, { agent_id: 'tu', name: 'Tuner' }] }
            if (sql.includes('desktop_intake_github_projects')) {
                expect((query as { args: unknown[] }).args).toEqual(['1'])
                return { rows: [
                    { body: record([project('acme/openflix'), project('acme/dvr-tuner'), project('acme/android'), project('acme/gone', true)], [['acme/openflix', 'acme/dvr-tuner'], ['acme/android', 'acme/openflix'], ['acme/gone', 'acme/other']]) },
                    { body: 'not json' },
                ] }
            }
            throw new Error(`unexpected ${sql}`)
        },
    } as never
    listDesktopAgents.mockResolvedValue([agent('of', 'OpenFlix Dev'), agent('tu', 'Tuner Dev'), agent('an', 'Android Dev'), agent('ot', 'Other Dev'), agent('w', 'Writer'), agent('t', 'Test Bot', false)])
    const repositories: Record<string, { owner: string; name: string }> = { 'engine-of': { owner: 'Acme', name: 'OpenFlix' }, 'engine-tu': { owner: 'acme', name: 'dvr-tuner' }, 'engine-an': { owner: 'acme', name: 'android' }, 'engine-ot': { owner: 'acme', name: 'other' } }
    getAgent.mockImplementation(async (_engine: unknown, id: string) => config(repositories[id] ? { desktopRepository: repositories[id] } : {}))
    readDesktopSetupView.mockResolvedValue(setup({ completedAt: 'done' }))

    const state = await readDesktopTeamState({ workspaceId: 1 } as never, fakeDb, connections)
    const byName = Object.fromEntries(state.map(member => [member.name, member]))
    expect(byName['OpenFlix Dev']).toMatchObject({ repository: 'Acme/OpenFlix', box: 'OpenFlix', linkedRepositories: ['acme/dvr-tuner', 'acme/android'], teammates: ['Tuner Dev', 'Android Dev'] })
    expect(byName['Tuner Dev']).toMatchObject({ repository: 'acme/dvr-tuner', box: 'Tuner', linkedRepositories: ['Acme/OpenFlix'], teammates: ['OpenFlix Dev'] })
    expect(byName['Android Dev']).toMatchObject({ teammates: ['OpenFlix Dev'] })
    // A link to a project the person removed links nothing.
    expect(byName['Other Dev']).toMatchObject({ repository: 'acme/other', linkedRepositories: [], teammates: [] })
    // Without a repository: the switched-on coworkers in its Box; a switched-off one is never a teammate.
    expect(byName['Writer']).toMatchObject({ box: 'OpenFlix', teammates: ['OpenFlix Dev'] })
    expect(byName['Writer']).not.toHaveProperty('repository')
    expect(JSON.stringify(state)).not.toMatch(/engine-|github\.com/)

    const text = desktopTeamChangesInstruction([], state, 12_000, [])!
    expect(text).toContain('"repository":"Acme/OpenFlix"')
    expect(text).toContain('"linkedRepositories":["acme/dvr-tuner","acme/android"]')
    expect(text).toContain('"teammates":["Tuner Dev","Android Dev"]')
    expect(text).toContain('you (coworker "Chief of Staff") may message every coworker that is on, never one that is off')
    expect(text).toContain('each coworker that is on may ask only the coworkers listed as its `teammates`')
    expect(text).toContain('You still only propose: the person approves the card')
})

test('teammates are left out rather than guessed when a coworker\'s settings or the links could not be read', async () => {
    const fakeDb = { execute: async (query: string | { sql: string }) => {
        const sql = typeof query === 'string' ? query : query.sql
        if (sql.includes('desktop_intake_github_projects')) throw new Error('SQLITE_ERROR: no such table: desktop_intake_github_projects')
        if (sql.includes('desktop_space_placements')) return { rows: [] }
        return { rows: [] }
    } } as never
    listDesktopAgents.mockResolvedValue([agent('a', 'Ada'), agent('b', 'Ben')])
    getAgent.mockImplementation(async (_engine: unknown, id: string) => { if (id === 'engine-b') throw new Error('engine down'); return config({ desktopRepository: { owner: 'acme', name: 'x' } }) })
    readDesktopSetupView.mockResolvedValue(setup())
    const state = await readDesktopTeamState(runtime, fakeDb, connections)
    // Ben could not be read, so whether he shares Ada's repository is unknown.
    expect(state.every(member => !('teammates' in member))).toBe(true)
    expect(state[0]).toMatchObject({ repository: 'acme/x' })
})
