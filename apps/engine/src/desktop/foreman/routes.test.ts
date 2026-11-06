import { beforeEach, afterEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ replay: false, session: null as null | { id: string; agentId: string; source: string; status: string; originAgentId: null; originSessionId: null }, run: null as null | { id: string; agentId: string; sessionId: string }, reserve: vi.fn(async () => ({ id: 'queued-user' })), model: vi.fn(async () => ({ connection: { id: 'conn' }, provider: 'codex', model: 'terra' })), claim: vi.fn(() => null), release: vi.fn() }))
vi.mock('../../agents/lock.js', () => ({ withAgentLock: async (_id: string, work: () => Promise<unknown>) => work() }))
vi.mock('../../agents/registry.js', () => ({ getAgent: async () => ({ id: 'foreman', config: { kind: 'foreman', enabled: true } }) }))
vi.mock('../../agents/availability.js', () => ({ resolveRunModel: state.model }))
vi.mock('../../db/repos/sessions.js', () => ({ getSession: async () => state.session }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: async () => state.run }))
vi.mock('../../db/repos/desktop-queued-turns.js', () => ({ getDesktopQueuedTurn: async () => state.replay, reserveDesktopQueuedTurn: state.reserve }))
vi.mock('../../runtime/run-control.js', () => ({ claimSession: state.claim, releaseSession: state.release, sessionClaim: () => undefined }))
vi.mock('../../runtime/loop.js', () => ({ runAgent: vi.fn() }))
vi.mock('../../runtime/run-stream-merge.js', () => ({ mergeRunStream: vi.fn() }))
vi.mock('../../runtime/stream.js', () => ({ resumeStreamResponse: () => new Response(null, { status: 204 }), toResumableStreamResponse: () => new Response('stream') }))
vi.mock('../policy.js', () => ({ desktopApp: () => true, assertDesktopProvider: vi.fn() }))
import { createDesktopForemanRoutes } from './routes.js'
import type { createDesktopForemanBridge } from './bridge.js'
const body = { binding: { workspaceId: '1', chatId: 'fmc_chat-0001', runId: '00000000-0000-4000-8000-000000000001', model: { connectionId: 'conn', model: 'terra' } }, sessionId: '00000000-0000-4000-8000-000000000002', text: 'Plan a team.', brief: { instructions: 'Propose, never approve.', tools: [] } }
const request = (input: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
const bridge = () => ({ admit: vi.fn(async () => {}), binding: vi.fn(), request: vi.fn(), close: vi.fn() }) as ReturnType<typeof createDesktopForemanBridge>
beforeEach(() => { state.replay = false; state.session = null; state.run = null; vi.clearAllMocks() })
afterEach(() => vi.restoreAllMocks())
test('replay miss creates no session, model resolution, admission or provider work', async () => {
    const port = bridge(), app = createDesktopForemanRoutes(() => port)
    const response = await app.request('/chat', request({ ...body, replayOnly: true }))
    expect(response.status).toBe(404); expect(state.reserve).not.toHaveBeenCalled(); expect(state.model).not.toHaveBeenCalled(); expect(port.admit).not.toHaveBeenCalled()
})
test('saved exact receipt resumes without needing the original model or an admission callback', async () => {
    state.replay = true; state.session = { id: body.sessionId, agentId: 'foreman', source: 'dashboard', status: 'open', originAgentId: null, originSessionId: null }; state.run = { id: body.binding.runId, agentId: 'foreman', sessionId: body.sessionId }
    const response = await createDesktopForemanRoutes(() => undefined).request('/chat', request({ ...body, replayOnly: true }))
    expect(response.status).toBe(204); expect(response.headers.get('x-run-id')).toBe(body.binding.runId); expect(state.model).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled()
})
test('new message reserves its first session atomically only after two exact UI admission checks', async () => {
    const port = bridge(), response = await createDesktopForemanRoutes(() => port).request('/chat', request(body))
    expect(response.status).toBe(200); expect(port.admit).toHaveBeenCalledTimes(2)
    expect(state.reserve).toHaveBeenCalledWith('foreman', expect.objectContaining({ foreman: { binding: body.binding, brief: body.brief }, message: body.text }), undefined, undefined, undefined, true)
})
test('hosted tool grants and a foreign existing session are refused without reserving a run', async () => {
    const port = bridge(), app = createDesktopForemanRoutes(() => port)
    expect((await app.request('/chat', request({ ...body, brief: { ...body.brief, hubToken: 'forged' } }))).status).toBe(400)
    expect((await app.request('/chat', request({ ...body, brief: { ...body.brief, tools: [{ name: 'shell' }] } }))).status).toBe(400)
    state.session = { id: body.sessionId, agentId: 'other', source: 'dashboard', status: 'open', originAgentId: null, originSessionId: null }
    expect((await app.request('/chat', request(body))).status).toBe(409)
    expect(port.admit).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled()
})
