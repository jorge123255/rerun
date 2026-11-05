import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
const mocks = vi.hoisted(() => ({ agent: vi.fn(), session: vi.fn(), status: vi.fn(), ticket: vi.fn(), db: vi.fn() }))
vi.mock('../database', () => ({ openDesktopDatabase: mocks.db }))
vi.mock('../store', () => ({ findDesktopAgent: mocks.agent, findDesktopSession: mocks.session }))
vi.mock('./service', () => ({ desktopScreenStatus: mocks.status, desktopScreenTicket: mocks.ticket }))
import { desktopBrowserRun, desktopBrowserRunTicket } from './browser-run'

const runtime = { dataRoot: '/test' } as DesktopRuntime
const agent = { id: 'local-agent', engineAgentId: 'engine-agent' }
const session = { id: 'local-session', agentId: agent.id, engineSessionId: 'engine-session' }
const run = { sessionId: session.engineSessionId, runId: 'run-1', kind: 'browser', site: 'example.com' }
const signal = new AbortController().signal
beforeEach(() => {
    vi.resetAllMocks()
    mocks.db.mockResolvedValue({})
    mocks.agent.mockResolvedValue(agent)
    mocks.session.mockResolvedValue(session)
    mocks.status.mockResolvedValue({ running: true, currentRun: run })
    mocks.ticket.mockResolvedValue({ socketUrl: 'ws://127.0.0.1/view', ticket: { expiresAt: 'later' } })
})
describe('browser run desktop projection', () => {
    it('maps only the owned current engine session back to its local chat', async () => {
        expect((await desktopBrowserRun(runtime, agent.id, session.id, signal)).trusted).toEqual({
            agentId: agent.id, sessionId: session.id, runId: run.runId, liveScreen: { kind: 'browser', site: 'example.com' },
        })
        expect(mocks.ticket).not.toHaveBeenCalled()
    })
    it.each([
        { running: false, currentRun: run },
        { running: true, currentRun: { ...run, sessionId: 'sibling-engine-session' } },
        { running: true, currentRun: null },
    ])('projects no browser from stopped, sibling or unclaimed screen state', async status => {
        mocks.status.mockResolvedValue(status)
        expect((await desktopBrowserRun(runtime, agent.id, session.id, signal)).trusted).toBeNull()
        await expect(desktopBrowserRunTicket(runtime, agent.id, session.id, run.runId, signal)).rejects.toMatchObject({ status: 409 })
        expect(mocks.ticket).not.toHaveBeenCalled()
    })
    it('refuses a foreign local conversation before querying the engine', async () => {
        mocks.session.mockResolvedValue({ ...session, agentId: 'another-coworker' })
        await expect(desktopBrowserRun(runtime, agent.id, session.id, signal)).rejects.toMatchObject({ status: 404 })
        expect(mocks.status).not.toHaveBeenCalled()
    })
    it('refuses a conversation removed while the engine state is being checked', async () => {
        mocks.status.mockImplementation(async () => { mocks.session.mockResolvedValue(null); return { running: true, currentRun: run } })
        await expect(desktopBrowserRunTicket(runtime, agent.id, session.id, run.runId, signal)).rejects.toMatchObject({ status: 409 })
        expect(mocks.ticket).not.toHaveBeenCalled()
    })
    it('requests a watch-only existing-guest ticket bound to exact engine session and run', async () => {
        await desktopBrowserRunTicket(runtime, agent.id, session.id, run.runId, signal)
        expect(mocks.ticket).toHaveBeenCalledWith(runtime, agent.id, 'watch', signal, undefined, true, { sessionId: session.engineSessionId, runId: run.runId })
        mocks.ticket.mockClear()
        await expect(desktopBrowserRunTicket(runtime, agent.id, session.id, 'old-run', signal)).rejects.toMatchObject({ status: 409 })
        expect(mocks.ticket).not.toHaveBeenCalled()
    })
})
