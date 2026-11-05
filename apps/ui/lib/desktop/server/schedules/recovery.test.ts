import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
const state = vi.hoisted(() => ({ list: vi.fn(), session: vi.fn(), run: vi.fn(), owner: 'engine-owner', deleting: false }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/engine/client', () => ({ listSessions: state.list, getSession: state.session, getRun: state.run }))
vi.mock('../settings', () => ({ engineOf: () => ({ baseUrl: 'http://127.0.0.1:3222', apiKey: 'fixture' }) }))
vi.mock('../store', () => ({ findDesktopAgent: async () => ({ id: 'local-owner', engineAgentId: state.owner }), sessionOf: (row: Record<string, unknown>) => ({ id: row.id, agentId: row.agent_id, title: row.title }) }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => db }))
vi.mock('../http', () => ({ desktopRoute: (_request: Request, work: (value: DesktopRuntime) => Promise<Response>) => work(runtime) }))
vi.mock('../tab-starts', () => ({ recoverPendingTabSessions: async () => {} }))
vi.mock('../session-tabs', () => ({ readDesktopChats: async () => ({ sessions: (await db.execute('SELECT * FROM desktop_sessions')).rows, tabs: null }) }))
vi.mock('../views', () => ({ desktopSessionView: (row: unknown) => row }))
import { recoverDesktopScheduleHistory, SCHEDULE_HISTORY_DEADLINE_MS } from './recovery'
import { GET } from '@/app/api/desktop/agents/[agentId]/sessions/route'
const runtime = { dataRoot: '/history-recovery-fixture', launchNonce: 'first', engine: { origin: 'http://127.0.0.1:3222', apiKey: 'fixture' } } as DesktopRuntime
const session = { id: 'scheduled-session', agentId: 'engine-owner', source: 'schedule', title: 'Daily report', createdAt: '2026-11-01T00:00:00Z' }
let db: Client
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
beforeEach(async () => {
    vi.clearAllMocks(); state.owner = 'engine-owner'; state.deleting = false
    const globals = globalThis as typeof globalThis & { [key: symbol]: Map<string, unknown> | undefined }
    globals[Symbol.for('rerun.desktop.schedule.history-recovery.v1')]?.clear()
    state.list.mockResolvedValue([session]); state.session.mockResolvedValue(session)
    db = createClient({ url: 'file::memory:' })
    await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT,engine_agent_id TEXT,workspace_id INTEGER);INSERT INTO desktop_agents VALUES('local-owner','engine-owner',1);
      CREATE TABLE desktop_deletions(agent_id TEXT);CREATE TABLE desktop_sessions(id TEXT,agent_id TEXT,engine_session_id TEXT UNIQUE,title TEXT,created_at TEXT,updated_at TEXT);`)
})
afterEach(() => { db.close(); vi.useRealTimers() })
const saved = () => db.execute('SELECT * FROM desktop_sessions')

test('recovers an owned scheduled chat once per launch and preserves its local identity after restart', async () => {
    expect(await recoverDesktopScheduleHistory(runtime, db, 'local-owner')).toBe(true)
    const first = (await saved()).rows[0]
    expect(first.engine_session_id).toBe(session.id)
    expect(await recoverDesktopScheduleHistory(runtime, db, 'local-owner')).toBe(true)
    expect(state.list).toHaveBeenCalledTimes(1)
    expect(await recoverDesktopScheduleHistory({ ...runtime, launchNonce: 'restarted' }, db, 'local-owner')).toBe(true)
    expect((await saved()).rows.map(row => row.id)).toEqual([first.id])
    expect(state.session).toHaveBeenCalledTimes(1)
})

test('a timed out listing shares one bounded attempt, throttles retries, and cannot adopt its late result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const listing = deferred<typeof session[]>(), entered = deferred<void>()
    state.list.mockImplementationOnce(() => { entered.resolve(); return listing.promise })
    const first = recoverDesktopScheduleHistory(runtime, db, 'local-owner'), second = recoverDesktopScheduleHistory(runtime, db, 'local-owner')
    await entered.promise
    await vi.advanceTimersByTimeAsync(SCHEDULE_HISTORY_DEADLINE_MS + 1)
    expect(await first).toBe(false); expect(await second).toBe(false)
    listing.resolve([session]); await Promise.resolve(); await Promise.resolve()
    expect((await saved()).rows).toHaveLength(0)
    expect(await recoverDesktopScheduleHistory(runtime, db, 'local-owner')).toBe(false)
    expect(state.list).toHaveBeenCalledTimes(1)
})

test('an owner change during recovery refuses adoption without caching a success for the replacement', async () => {
    const remote = deferred<typeof session>(), entered = deferred<void>()
    state.session.mockImplementationOnce(() => { entered.resolve(); return remote.promise })
    const pending = recoverDesktopScheduleHistory(runtime, db, 'local-owner')
    await entered.promise
    state.owner = 'replacement'; await db.execute("UPDATE desktop_agents SET engine_agent_id='replacement'")
    remote.resolve(session)
    expect(await pending).toBe(false)
    expect((await saved()).rows).toHaveLength(0)
})

test('owned history GET includes recovered local chats and preserves existing history with a warning while the engine is offline', async () => {
    const request = () => GET(new Request('http://127.0.0.1/agents/local-owner/sessions'), { params: Promise.resolve({ agentId: 'local-owner' }) })
    const recovered = await request()
    expect(recovered.status).toBe(200)
    const first = await recovered.json()
    expect(first.sessions).toHaveLength(1)
    expect(first.sessions[0].engine_session_id).toBe('scheduled-session')
    expect(first.scheduledHistoryWarning).toBeUndefined()
    const globals = globalThis as typeof globalThis & { [key: symbol]: Map<string, unknown> | undefined }
    globals[Symbol.for('rerun.desktop.schedule.history-recovery.v1')]?.clear()
    state.list.mockRejectedValueOnce(new Error('Offline'))
    const offline = await request(), body = await offline.json()
    expect(offline.status).toBe(200)
    expect(body.sessions).toEqual(first.sessions)
    expect(body.scheduledHistoryWarning).toContain('saved chats are available')
})
