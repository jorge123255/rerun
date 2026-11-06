import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopAgent, DesktopSession } from './store'
import type { DesktopRuntime } from './runtime'
import { DESKTOP_ATTENTION_DEADLINE_MS, readDesktopAttention } from './attention'
import { readDesktopBoardActivity } from './board-activity'

const mock = vi.hoisted(() => ({ agents: vi.fn(), sessions: vi.fn(), session: vi.fn(), question: vi.fn(), approval: vi.fn(), service: vi.fn(), secret: vi.fn(), runs: vi.fn(), owner: vi.fn() }))
vi.mock('./database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('./store', () => ({ listDesktopAgents: mock.agents, listDesktopSessions: mock.sessions, findDesktopSession: mock.session }))
vi.mock('./questions', () => ({ readDesktopQuestion: mock.question }))
vi.mock('./takeover', () => ({ readDesktopTakeover: async () => ({ takeover: null }) }))
vi.mock('./approvals', () => ({ readDesktopApproval: mock.approval }))
vi.mock('./service-requests/view', () => ({ readDesktopServiceRequestView: mock.service }))
vi.mock('./secret-requests/binding', () => ({ readDesktopSecretRequestView: mock.secret }))
vi.mock('./coworker-delete', () => ({ assertCoworkerNotDeleting: mock.owner }))
vi.mock('./settings', () => ({ engineOf: () => ({}) }))
vi.mock('@/lib/engine/client', () => ({ listRuns: mock.runs }))

let runtime: DesktopRuntime
const agents: DesktopAgent[] = [], sessions: DesktopSession[] = []
const date = '2026-11-04T12:00:00.000Z'
const agent = (id: string, enabled = true, workspaceId = 1): DesktopAgent => ({ id, workspaceId, name: id.toUpperCase(), engineAgentId: 'engine-' + id, description: '', enabled, createdAt: date, updatedAt: date })
const session = (id: string, owner: string, updatedAt = date): DesktopSession => ({ id, agentId: owner, engineSessionId: 'engine-' + id, title: id, createdAt: date, updatedAt, model: null, modelConnectionId: null })
const question = (id: string, text = 'Which color?') => ({ question: { id, messageId: 'm-' + id, toolCallId: 't-' + id, questions: [{ question: text, options: [] }] } })
const approval = (id: string) => ({ approval: { id, messageId: 'm-' + id, toolCallId: 't-' + id, approvals: [{ action: 'Publish this draft', detail: 'Private details stay in the chat.' }] } })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

beforeEach(() => {
    vi.resetAllMocks(); agents.length = 0; sessions.length = 0
    runtime = { protocolVersion: 1, launchNonce: crypto.randomUUID(), buildId: 'attention', workspaceId: 1, dataRoot: '/tmp/attention-fixture',
        app: { origin: 'http://127.0.0.1:3100', sessionToken: 'a'.repeat(48) }, engine: { origin: 'http://127.0.0.1:3200', apiKey: 'fixture' } }
    mock.agents.mockImplementation(async () => [...agents])
    mock.sessions.mockImplementation(async (_db, owner) => sessions.filter(row => row.agentId === owner))
    mock.session.mockImplementation(async (_db, id) => sessions.find(row => row.id === id) ?? null)
    mock.question.mockResolvedValue({ question: null }); mock.approval.mockResolvedValue({ approval: null })
    mock.service.mockResolvedValue({ request: null }); mock.secret.mockResolvedValue({ request: null })
    mock.runs.mockResolvedValue([]); mock.owner.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

test('suggested apps remain attention until the server confirms their result, including a disabled owner', async () => {
    agents.push(agent('alice', false))
    sessions.push(session('apps', 'alice'))
    mock.service.mockResolvedValue({ request: { serviceRequestId: 'service-request', services: [{ slug: 'notion', reason: 'Connect the project notes' }] } })
    expect((await readDesktopAttention(runtime)).items).toMatchObject([{ id: 'service-request', kind: 'service', agentId: 'alice', agentEnabled: false, sessionId: 'apps', summary: 'Connect the project notes' }])
    expect(mock.service.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal)
    mock.service.mockResolvedValue({ request: { serviceRequestId: 'service-request', services: [{ slug: 'notion' }], receipt: { accepted: true } } })
    expect((await readDesktopAttention(runtime)).items).toEqual([])
})

test('projects canonical pending requests across owners, with bounded summaries, disabled owners and stable latest-first ties', async () => {
    agents.push(agent('alice'), agent('bob', false), agent('foreign', true, 2))
    sessions.push(session('old', 'alice', '2026-11-03T12:00:00.000Z'), session('a', 'alice'), session('b', 'bob'), session('elsewhere', 'foreign'))
    mock.sessions.mockImplementation(async (_db, owner) => owner === 'alice' ? [sessions[0], sessions[1], sessions[1], sessions[3]] : sessions.filter(row => row.agentId === owner))
    mock.question.mockImplementation(async (_runtime, id) => id === 'a' ? question('question-a', '  ' + 'Which\n color? '.repeat(30)) : { question: null })
    mock.approval.mockImplementation(async (_runtime, id) => id === 'old' || id === 'b' ? approval('approval-' + id) : { approval: null })
    const result = await readDesktopAttention(runtime)
    expect(result.items.map(item => item.sessionId)).toEqual(['a', 'b', 'old'])
    expect(result.items[0]).toMatchObject({ id: 'question-a', kind: 'question', agentId: 'alice', agentName: 'ALICE', title: 'a', updatedAt: date })
    expect(result.items[0].summary).toHaveLength(280)
    expect(result.items[0].summary).not.toContain('\n')
    expect(result.items[1]).toMatchObject({ kind: 'approval', agentId: 'bob', agentEnabled: false })
    expect(result.unavailableAgentIds).toEqual([])
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true)
    expect(mock.question.mock.calls.map(call => call[1]).sort()).toEqual(['a', 'b', 'old'])
    expect(mock.approval.mock.calls.map(call => call[1]).sort()).toEqual(['b', 'old'])
    expect(JSON.stringify(result)).not.toContain('engine-')
    expect(JSON.stringify(result)).not.toContain('Private details')
})

test('one four-worker scan serves concurrent board and inbox reads, without retaining completed snapshots', async () => {
    agents.push(agent('alice'), agent('bob'))
    for (let index = 0; index < 12; index++) sessions.push(session(String(index), index % 2 ? 'alice' : 'bob'))
    const started = deferred(), release = deferred()
    let active = 0, peak = 0
    mock.question.mockImplementation(async () => {
        active++; peak = Math.max(peak, active)
        if (active === 4) started.resolve()
        await release.promise; active--
        return { question: null }
    })
    const inbox = readDesktopAttention(runtime)
    const same = readDesktopAttention({ ...runtime })
    const board = readDesktopBoardActivity(runtime)
    expect(same).toBe(inbox)
    await started.promise
    expect(mock.question).toHaveBeenCalledTimes(4)
    release.resolve()
    const [snapshot, activity] = await Promise.all([inbox, board])
    expect(peak).toBe(4)
    expect(mock.question).toHaveBeenCalledTimes(12)
    expect(mock.approval).toHaveBeenCalledTimes(12)
    expect(activity.attention).toBe(snapshot)
    mock.question.mockImplementation(async (_runtime, id) => id === '0' ? question('new-pending') : { question: null })
    expect((await readDesktopAttention(runtime)).items).toHaveLength(1)
    expect(mock.question).toHaveBeenCalledTimes(24)
})

test('failed reads stay explicit and cannot erase other pending chats or falsely make a coworker idle', async () => {
    agents.push(agent('alice'), agent('bob'), agent('carol'), agent('dave'), agent('eve'))
    for (const owner of agents) sessions.push(session(owner.id + '-chat', owner.id))
    sessions.push(session('alice-failed', 'alice'))
    mock.question.mockImplementation(async (_runtime, id) => {
        if (id === 'alice-failed' || id === 'carol-chat' || id === 'eve-chat') throw new Error('Unavailable')
        return question(id)
    })
    mock.runs.mockImplementation(async (_connection, id) => {
        if (id === 'engine-dave') throw new Error('Offline')
        return id === 'engine-bob' || id === 'engine-eve' ? [{ status: 'running' }] : []
    })
    const result = await readDesktopBoardActivity(runtime)
    expect(result.agents).toEqual({ alice: 'waiting_human', bob: 'working', carol: 'unreachable', dave: 'unreachable', eve: 'working' })
    expect(result.attention?.items.map(item => item.agentId)).toEqual(['alice', 'bob', 'dave'])
    expect(result.attention?.unavailableAgentIds).toEqual(['alice', 'carol', 'eve'])
    expect(mock.approval).not.toHaveBeenCalled()
})

test('late deletion or reassignment cannot publish a stale navigation target', async () => {
    agents.push(agent('alice'), agent('bob'))
    sessions.push(session('deleted', 'alice'), session('reassigned', 'alice'), session('slow', 'bob'))
    const twoResolved = deferred(), release = deferred()
    let resolved = 0
    mock.question.mockImplementation(async (_runtime, id) => {
        if (id === 'slow') await release.promise
        return question(id)
    })
    mock.session.mockImplementation(async (_db, id) => {
        if (id !== 'slow' && ++resolved === 2) twoResolved.resolve()
        return sessions.find(row => row.id === id) ?? null
    })
    const read = readDesktopAttention(runtime)
    await twoResolved.promise
    sessions.splice(sessions.findIndex(row => row.id === 'deleted'), 1)
    sessions.find(row => row.id === 'reassigned')!.agentId = 'bob'
    agents.splice(agents.findIndex(row => row.id === 'bob'), 1)
    release.resolve()
    const result = await read
    expect(result.items).toEqual([])
    expect(result.unavailableAgentIds).toEqual([])
})

test('runtime identity isolates in-flight scans and a failed local listing remains unavailable', async () => {
    agents.push(agent('alice'))
    mock.sessions.mockRejectedValue(new Error('Local listing failed'))
    const first = readDesktopAttention(runtime)
    const otherLaunch = readDesktopAttention({ ...runtime, launchNonce: crypto.randomUUID() })
    const otherRoot = readDesktopAttention({ ...runtime, dataRoot: '/tmp/other-attention-fixture' })
    expect(first).not.toBe(otherLaunch); expect(first).not.toBe(otherRoot)
    for (const result of await Promise.all([first, otherLaunch, otherRoot])) expect(result).toMatchObject({ items: [], unavailableAgentIds: ['alice'] })
})

test('one deadline aborts four stalled reads, leaves every unscanned owner unavailable and releases the next refresh', async () => {
    for (let owner = 0; owner < 10; owner++) {
        agents.push(agent('owner-' + owner))
        for (let chat = 0; chat < 10; chat++) sessions.push(session(`${owner}-${chat}`, 'owner-' + owner))
    }
    const controller = new AbortController(), started = deferred()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    let active = 0, cancelled = 0
    mock.question.mockImplementation(async (_runtime, _id, options: { signal: AbortSignal }) => {
        expect(options.signal).toBe(controller.signal)
        active++
        if (active === 4) started.resolve()
        try {
            await new Promise<void>((_resolve, reject) => {
                options.signal.throwIfAborted()
                options.signal.addEventListener('abort', () => { cancelled++; reject(options.signal.reason) }, { once: true })
            })
            return { question: null }
        } finally { active-- }
    })
    const pending = readDesktopAttention(runtime)
    const shared = readDesktopAttention({ ...runtime })
    expect(shared).toBe(pending)
    await started.promise
    expect(timeout).toHaveBeenCalledExactlyOnceWith(DESKTOP_ATTENTION_DEADLINE_MS)
    controller.abort(new DOMException('Attention deadline', 'TimeoutError'))
    const result = await pending
    expect(active).toBe(0); expect(cancelled).toBe(4)
    expect(mock.question).toHaveBeenCalledTimes(4)
    expect(mock.approval).not.toHaveBeenCalled()
    expect(result.items).toEqual([])
    expect(result.unavailableAgentIds).toEqual(agents.map(owner => owner.id).sort())
    timeout.mockRestore()
    mock.question.mockImplementation(async (_runtime, id) => id === '9-9' ? question('recovered') : { question: null })
    const recovered = await readDesktopAttention(runtime)
    expect(recovered.items.map(item => item.id)).toEqual(['recovered'])
    expect(recovered.unavailableAgentIds).toEqual([])
    expect(mock.question).toHaveBeenCalledTimes(104)
})

test('run-status reads share a whole-board deadline and settle as unreachable when cancelled', async () => {
    agents.push(agent('alice'), agent('bob'))
    const controller = new AbortController(), started = deferred()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    let active = 0
    mock.runs.mockImplementation(async (_connection, _id, _filter, options: { signal: AbortSignal }) => {
        expect(options.signal).toBe(controller.signal)
        active++
        if (active === 2) started.resolve()
        try {
            return await new Promise<never>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
        } finally { active-- }
    })
    const pending = readDesktopBoardActivity(runtime)
    await started.promise
    controller.abort(new DOMException('Board deadline', 'TimeoutError'))
    expect((await pending).agents).toEqual({ alice: 'unreachable', bob: 'unreachable' })
    expect(active).toBe(0)
})


test('credential attention exposes only field labels and keeps the request visible for a disabled coworker', async () => {
    agents.push(agent('alice', false)); sessions.push(session('credentials', 'alice'))
    mock.secret.mockResolvedValue({ request: { requestId: 'credential-request', fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example key' }, { key: 'OTHER_TOKEN', label: 'Other token' }], createdAt: date } })
    expect((await readDesktopAttention(runtime)).items).toMatchObject([{ id: 'credential-request', kind: 'secret', agentId: 'alice', agentEnabled: false, sessionId: 'credentials', summary: 'Needs Example key (+1 more)', updatedAt: date }])
    expect(mock.secret.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal)
    mock.secret.mockResolvedValue({ request: null })
    expect((await readDesktopAttention(runtime)).items).toEqual([])
})
