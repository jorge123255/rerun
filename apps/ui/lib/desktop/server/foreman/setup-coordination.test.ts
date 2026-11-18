import type { Client } from '@libsql/client'
import { createHash } from 'node:crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'

vi.mock('server-only', () => ({}))
const ports = vi.hoisted(() => ({
    live: vi.fn(), targets: vi.fn(), turn: vi.fn(), owner: vi.fn(), setup: vi.fn(), waiting: vi.fn(),
    runtime: vi.fn(), agent: vi.fn(), session: vi.fn(), chief: vi.fn(), messages: vi.fn(), source: vi.fn(),
    connector: vi.fn(), installs: vi.fn(), start: vi.fn(),
}))
vi.mock('../coworker-calls/authority', () => ({ authorizeDesktopCoworkerCall: ports.live, listDesktopCoworkerCallTargets: ports.targets }))
vi.mock('./chat-store', () => ({ foremanTurn: ports.turn, ownedForemanChat: ports.owner }))
vi.mock('../setup/service', () => ({ observeDesktopSetup: ports.setup, readDesktopSetupWaitingChat: ports.waiting }))
vi.mock('../runtime', () => ({ readDesktopRuntime: ports.runtime }))
vi.mock('../store', () => ({ findDesktopAgent: ports.agent, findDesktopSession: ports.session }))
vi.mock('../settings', () => ({ engineOf: () => ({}) }))
vi.mock('@/lib/engine/client', () => ({ getAgent: ports.chief, getSessionMessages: ports.messages, request: ports.source }))
vi.mock('../connector-approvals/store', () => ({ pendingConnectorApproval: ports.connector }))
vi.mock('../tool-install/runtime', () => ({ readDesktopToolInstallHistory: ports.installs }))
vi.mock('../engine', () => ({ startDesktopChat: ports.start }))

const { inspectChiefSetup, applyChiefSetupReply } = await import('./setup-coordination')
const db = {} as Client
const runtime = { dataRoot: '/disposable', workspaceId: 1, launchNonce: 'launch' } as DesktopRuntime
const binding = { chatId: 'chief-chat', workspaceId: '1', runId: 'chief-run', model: { connectionId: 'test', model: 'fixture' } }
const target = { publicAgentId: 'qa', engineAgentId: 'engine-qa', name: 'QA tester', callable: true, enabled: true }
const caller = { publicAgentId: 'foreman', publicSessionId: 'chief-chat', targets: [target] }
const setup = { pending: true, required: true, completedAt: null, skipped: false, sessionId: 'setup-chat', canStart: false, canContinue: true, revision: 'rev1' }
const msg = (id: string, role: string, content: unknown) => ({ id, sessionId: 'engine-setup', role, contentJson: JSON.stringify(content), toolCallsJson: null })
const last = msg('question', 'assistant', [{ type: 'text', text: 'Which platform should I test?' }])
const step = { sessionId: 'setup-chat', revision: 'rev1', stepId: createHash('sha256').update(JSON.stringify([last.id, last.contentJson])).digest('hex') }
const inspect = () => inspectChiefSetup(runtime, db, binding, 'QA tester', new AbortController().signal)
const send = (assertCard = async () => {}) => applyChiefSetupReply(runtime, db, binding, 'qa', { ...step, text: 'Start with iOS.' }, 'request', new AbortController().signal, assertCard)

beforeEach(() => {
    vi.resetAllMocks()
    ports.turn.mockResolvedValue({ body: { binding, sessionId: 'chief-engine-session' } })
    ports.live.mockResolvedValue({ ok: true, caller })
    ports.targets.mockResolvedValue([{ agentId: 'qa', callable: true }])
    ports.owner.mockResolvedValue({})
    ports.runtime.mockResolvedValue(runtime)
    ports.agent.mockResolvedValue({ id: 'qa', name: 'QA tester', engineAgentId: 'engine-qa', enabled: true, workspaceId: 1 })
    ports.session.mockResolvedValue({ id: 'setup-chat', engineSessionId: 'engine-setup', agentId: 'qa' })
    ports.chief.mockImplementation(async (_engine, id: string) => id === 'foreman'
        ? { id, config: { kind: 'foreman', enabled: true, tools: { desktopToolGrants: { callAgent: true } } } }
        : { id, config: { enabled: true } })
    ports.messages.mockResolvedValue([msg('user', 'user', 'Private earlier instructions'), last])
    ports.source.mockResolvedValue({ agentId: 'engine-qa', sessionId: 'engine-setup', request: null })
    ports.connector.mockResolvedValue(null)
    ports.installs.mockResolvedValue([])
    ports.waiting.mockResolvedValue({ sessionId: 'setup-chat' })
    ports.setup.mockResolvedValue(setup)
    ports.start.mockImplementation(async (_runtime, input, _unused, options) => {
        await options.chiefSetupReply.assertCurrent()
        return { response: new Response(null, { headers: { 'x-run-id': input.requestId } }), sessionId: input.sessionId }
    })
})

test('reads only the latest visible setup message for the owned, explicitly allowed coworker', async () => {
    expect(await inspect()).toEqual({ state: 'awaiting_reply', coworker: 'QA tester', agentId: 'qa', lastMessage: 'Which platform should I test?', step })
    expect(ports.start).not.toHaveBeenCalled()
    expect(ports.live).toHaveBeenCalledTimes(2)
    expect(ports.live.mock.calls[0]![2]).toEqual({ engineAgentId: 'foreman', engineSessionId: 'chief-engine-session', engineRunId: 'chief-run' })
})
test('refuses a stopped Chief, revoked contact, ambiguous name, changed owner, and a frozen workspace', async () => {
    ports.live.mockResolvedValueOnce({ ok: false })
    await expect(inspect()).rejects.toMatchObject({ status: 403 })
    ports.live.mockResolvedValueOnce({ ok: true, caller: { ...caller, targets: [target, { ...target, publicAgentId: 'other' }] } })
    await expect(inspect()).rejects.toMatchObject({ status: 403 })
    expect(ports.messages).not.toHaveBeenCalled()
    ports.chief.mockResolvedValueOnce({ id: target.engineAgentId, config: { enabled: false } })
    await expect(inspect()).rejects.toMatchObject({ status: 403 })
    expect(ports.messages).not.toHaveBeenCalled()
    ports.live.mockResolvedValueOnce({ ok: true, caller }).mockResolvedValueOnce({ ok: true, caller: { ...caller, targets: [{ ...target, callable: false }] } })
    await expect(inspect()).rejects.toMatchObject({ status: 403 })
    ports.session.mockResolvedValueOnce({ agentId: 'other' })
    await expect(inspect()).rejects.toMatchObject({ status: 409 })
    const { setDesktopWorkspaceFrozen } = await import('../workspace-admission')
    setDesktopWorkspaceFrozen(runtime, true)
    try { await expect(send()).rejects.toMatchObject({ status: 409 }) }
    finally { setDesktopWorkspaceFrozen(runtime, false) }
    expect(ports.start).not.toHaveBeenCalled()
})
test.each([
    [{ ...setup, pending: false, completedAt: 'saved' }, 'ready'],
    [{ ...setup, pending: false, skipped: true }, 'skipped'],
    [{ ...setup, sessionId: null, canStart: true, canContinue: false }, 'needs_start'],
    [{ ...setup, sessionId: null, canContinue: true }, 'needs_continue'],
] as const)('reports the saved setup state without starting it', async (value, state) => {
    ports.setup.mockResolvedValue(value)
    expect(await inspect()).toEqual({ state, coworker: 'QA tester', agentId: 'qa' })
    expect(ports.messages).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
})
test('reads the visible words of a real turn that thought and used tools, never its reasoning or tool data', async () => {
    const turn = msg('real', 'assistant', [
        { type: 'reasoning', text: 'hidden chain' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'functions.exec', input: { code: 'private tool input' }, providerExecuted: true },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'team_status', input: { agentId: 'x' }, providerExecuted: true },
        { type: 'tool-result', toolCallId: 'c2', toolName: 'team_status', output: { type: 'json', value: 'private tool output' } },
        { type: 'tool-result', toolCallId: 'c1', toolName: 'functions.exec', output: { type: 'text', value: 'private tool output' } },
        { type: 'reasoning', text: 'more hidden chain' },
        { type: 'text', text: 'Setup is still pending. Which pull request should I review first?' },
    ])
    ports.messages.mockResolvedValue([msg('user', 'user', 'is setup done'), turn])
    const result = await inspect()
    expect(result).toMatchObject({ state: 'awaiting_reply', lastMessage: 'Setup is still pending. Which pull request should I review first?' })
    expect(JSON.stringify(result)).not.toMatch(/hidden chain|private tool/)
    expect(result.step?.stepId).toBe(createHash('sha256').update(JSON.stringify([turn.id, turn.contentJson])).digest('hex'))
})
test('a turn that ends with suggested reply chips is still an ordinary question', async () => {
    const chips = { ...msg('chips', 'assistant', [{ type: 'text', text: 'Which pull request first?' }]), toolCallsJson: JSON.stringify([{ toolCallId: 'r', toolName: 'suggest_replies', input: { replies: ['Newest'] } }]) }
    ports.messages.mockResolvedValue([last, chips])
    expect(await inspect()).toMatchObject({ state: 'awaiting_reply', lastMessage: 'Which pull request first?' })
    const other = { ...chips, toolCallsJson: JSON.stringify([{ toolCallId: 'x', toolName: 'web_fetch', input: {} }]) }
    ports.messages.mockResolvedValue([last, other])
    expect((await inspect()).state).toBe('needs_owner')
})
test('hands the Chief the end of a long setup message instead of refusing it', async () => {
    const long = 'Background. '.repeat(700) + 'Which route do you want to take?'
    ports.messages.mockResolvedValue([last, msg('long', 'assistant', long)])
    const result = await inspect()
    expect(result.state).toBe('awaiting_reply')
    expect(result.lastMessage!.length).toBeLessThanOrEqual(6000)
    expect(result.lastMessage!.startsWith('…')).toBe(true)
    expect(result.lastMessage!.endsWith('Which route do you want to take?')).toBe(true)
})
test('withholds stale, missing, unfinished, person-facing and sensitive messages from the Chief', async () => {
    for (const row of [
        msg('user', 'user', 'newer owner response'), msg('tool', 'tool', 'secret tool output'),
        msg('unfinished', 'assistant', [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'web_fetch', input: {} }]),
        msg('ended-on-tool', 'assistant', [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'web_fetch', input: {} }, { type: 'tool-result', toolCallId: 'c1', toolName: 'web_fetch', output: {} }]),
        msg('person-facing', 'assistant', [{ type: 'tool-call', toolCallId: 'q', toolName: 'request_secret', input: {} }, { type: 'tool-result', toolCallId: 'q', toolName: 'request_secret', output: {} }, { type: 'text', text: 'Done?' }]),
        msg('unknown-part', 'assistant', [{ type: 'file', mediaType: 'image/png', data: 'x' }, { type: 'text', text: 'See this?' }]),
        msg('sensitive', 'assistant', 'Authorization: Bearer synthetic-private-string'),
        msg('credential', 'assistant', 'Please send your API key.'),
    ]) {
        ports.messages.mockResolvedValue([last, row])
        const result = await inspect()
        expect(result.state).toBe('needs_owner')
        expect(result).not.toHaveProperty('lastMessage')
        expect(result).not.toHaveProperty('step')
    }
    ports.waiting.mockResolvedValue(null)
    expect(await inspect()).toEqual({ state: 'working', agentId: 'qa', coworker: 'QA tester' })
})
test('names a structured app decision without exposing contents, accepting plain replies, or treating failed reads as clear', async () => {
    ports.source.mockResolvedValue({ agentId: 'engine-qa', sessionId: 'engine-setup', request: { status: 'done', input: 'private details' } })
    expect(await inspect()).toEqual({ state: 'needs_owner', blocker: 'mcp', ownerSessionId: 'setup-chat', agentId: 'qa', coworker: 'QA tester' })
    await expect(send()).rejects.toMatchObject({ status: 409 })
    ports.source.mockRejectedValue(new Error('unavailable'))
    await expect(inspect()).rejects.toThrow('unavailable')
    ports.source.mockResolvedValue({ agentId: 'foreign', sessionId: 'engine-setup', request: null })
    await expect(inspect()).rejects.toMatchObject({ status: 409 })
})
test('sends only reviewed, attributed guidance to the pinned setup session with the stable request and step', async () => {
    const card = vi.fn(async () => {})
    expect(await send(card)).toEqual({ sessionId: 'setup-chat', requestId: 'request' })
    expect(card).toHaveBeenCalledTimes(2)
    expect(ports.start.mock.calls[0]).toEqual([runtime, {
        agentId: 'qa', sessionId: 'setup-chat', requestId: 'request', text: 'Start with iOS.',
    }, undefined, { chiefSetupReply: { stepId: step.stepId, assertCurrent: expect.any(Function) } }])
})
test('dispatch rechecks changed question, setup revision, workspace, superseded card and target permission', async () => {
    ports.messages.mockResolvedValueOnce([msg(last.id, 'assistant', 'Changed words under the same ID')])
    await expect(send()).rejects.toMatchObject({ status: 409 })
    ports.setup.mockResolvedValueOnce({ ...setup, revision: 'different' })
    await expect(send()).rejects.toMatchObject({ status: 409 })
    ports.runtime.mockResolvedValueOnce({ ...runtime, dataRoot: '/different' })
    await expect(send()).rejects.toMatchObject({ status: 409 })
    const dismissed = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Card dismissed'))
    await expect(send(dismissed)).rejects.toThrow('Card dismissed')
    ports.targets.mockResolvedValueOnce([{ agentId: 'qa', callable: true }]).mockResolvedValueOnce([{ agentId: 'qa', callable: false }])
    await expect(send()).rejects.toMatchObject({ status: 403 })
    ports.chief.mockResolvedValue({ id: 'foreman', config: { enabled: true, kind: 'foreman', tools: { desktopToolGrants: { callAgent: false } } } })
    await expect(send()).rejects.toMatchObject({ status: 403 })
})
