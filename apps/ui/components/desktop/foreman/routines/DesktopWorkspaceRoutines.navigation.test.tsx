// @vitest-environment happy-dom
import { act, type ReactNode, type HTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { desktopWorkspaceRoutineFingerprint } from '@/lib/desktop/server/workspace-routines/mutations'
import { desktopWorkspaceRoutinesViewSchema } from '../../../../../../packages/contracts/src/desktop-workspace-routines'

type SavedRun = { id: string; agentId: string; sessionId: string; triggerSource: string; triggerSlug: string; status: string; startedAt: string }
const state = vi.hoisted(() => ({ db: null as unknown as Client, runs: [] as SavedRun[], receipt: null as null | { fingerprint: string; result: unknown }, launches: 0 }))
const schedule = { slug: 'daily-copy', name: 'Copied QA routine', description: '', body: 'Return NOTICE27', enabled: false, cron: '0 8 * * *', runAt: null, timezone: 'UTC', lastRunAt: null, revision: 'reviewed-v1' }
vi.mock('motion/react', () => ({
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: function MockMotionDiv({ children, layout: _layout, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: HTMLAttributes<HTMLDivElement> & { layout?: unknown; initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }) { return <div {...props}>{children}</div> } },
}))
vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: () => null }))
vi.mock('../../../../../../packages/ui/src/iso-grid/components/buddy/AgentBuddy', () => ({ AgentBuddy: () => null }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: async () => state.db }))
vi.mock('@/lib/desktop/server/store', () => ({
    findDesktopAgent: async (_db: Client, id: string) => id === 'local-copy' ? { id, engineAgentId: 'engine-copy', name: 'QA copy', enabled: true } : null,
    listDesktopAgents: async () => [{ id: 'local-copy', engineAgentId: 'engine-copy', name: 'QA copy', enabled: true }],
    sessionOf: (row: Record<string, unknown>) => ({ id: String(row.id), title: String(row.title) }),
}))
vi.mock('@/lib/desktop/server/settings', () => ({ engineOf: (runtime: DesktopRuntime) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }) }))
vi.mock('@/lib/desktop/server/schedules-binding', () => ({ authorizeDesktopSchedules: async () => {} }))
vi.mock('@/lib/engine/client', () => ({
    EngineRequestError: class extends Error {},
    getAgent: async (_engine: unknown, id: string) => { expect(id).toBe('engine-copy'); return { config: { enabled: true, setup: { required: false } } } },
    listRuns: async (_engine: unknown, id: string) => { expect(id).toBe('engine-copy'); return state.runs },
    getSession: async (_engine: unknown, id: string, sessionId: string) => { expect(id).toBe('engine-copy'); expect(sessionId).toBe('engine-result-session'); return { id: sessionId, agentId: id, source: 'schedule', title: 'Copy result NOTICE27', createdAt: '2026-11-06T08:00:00.000Z' } },
    getRun: async (_engine: unknown, id: string, runId: string) => { expect(id).toBe('engine-copy'); return state.runs.find(run => run.id === runId) },
    request: async <T,>(_engine: unknown, path: string, init: RequestInit, parse: (body: unknown) => T) => {
        expect(path).toBe('/desktop/workspace-routines/engine-copy')
        if (init.method === 'GET') return parse({ schedules: [schedule] })
        const body = JSON.parse(String(init.body))
        if (body.operation === 'read') return parse(state.receipt ?? { fingerprint: desktopWorkspaceRoutineFingerprint(body.input), result: null })
        state.launches++
        state.runs = [{ id: 'completed-copy-run', agentId: 'engine-copy', sessionId: 'engine-result-session', triggerSource: 'schedule', triggerSlug: schedule.slug, status: 'done', startedAt: '2026-11-06T08:00:00.000Z' }]
        state.receipt = { fingerprint: desktopWorkspaceRoutineFingerprint(body.input), result: { schedule, revision: schedule.revision, run: { runId: 'completed-copy-run', sessionId: 'engine-result-session' } } }
        return parse(state.receipt)
    },
}))
import { createDesktopWorkspaceRoutinesApi } from '@/lib/desktop/server/workspace-routines/api'
import { desktopWorkspaceRoutinesAuthority } from '@/lib/desktop/server/workspace-routines/runtime'
import { createDesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import { DesktopWorkspaceRoutines } from './DesktopWorkspaceRoutines'

let root: Root | undefined
let directory: string
let databaseUrl: string
const runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'routine-navigation-test', buildId: 'test', dataRoot: '/synthetic-routines', app: { origin: 'http://127.0.0.1:3210', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'fake-key' } } satisfies DesktopRuntime
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-routine-result-navigation-'))
    databaseUrl = `file:${join(directory, 'app.db')}`
    state.db = createClient({ url: databaseUrl }); state.runs = []; state.receipt = null; state.launches = 0
    await state.db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT,engine_agent_id TEXT,workspace_id INTEGER);
        INSERT INTO desktop_agents VALUES('local-copy','engine-copy',1),('local-original','engine-original',1);
        CREATE TABLE desktop_deletions(agent_id TEXT);
        CREATE TABLE desktop_sessions(id TEXT,agent_id TEXT,engine_session_id TEXT UNIQUE,title TEXT,created_at TEXT,updated_at TEXT);
        INSERT INTO desktop_sessions VALUES('original-chat','local-original','original-engine-chat','Original conversation','2026-11-01','2026-11-01');`)
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
        // Exercise the production runtime, API schemas, canonical adoption and client
        // parser together. The external engine boundary alone is synthetic.
        const api = createDesktopWorkspaceRoutinesApi(await desktopWorkspaceRoutinesAuthority(runtime))
        const request = new Request(`${runtime.app.origin}/api/desktop/workspace/routines`, init)
        return init?.method === 'POST' ? api.POST(request) : api.GET(request)
    })
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; state.db.close(); await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const settle = async () => { await act(async () => { await new Promise(done => setTimeout(done, 5)) }) }
async function click(label: string) {
    const node = [...document.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
    expect(node, `Expected ${label}`).toBeDefined()
    await act(async () => {
        if (node!.getAttribute('aria-haspopup') === 'menu') { node!.focus(); node!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) }
        else node!.click()
    }); await settle()
}
async function openPaused() {
    const heading = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Paused'))
    expect(heading, 'Expected the original collapsed Paused group').toBeDefined()
    await act(async () => heading!.click()); await settle()
}

test('completed manual copy run survives client parsing and reload, and Open result chat navigates its canonical history', async () => {
    const onOpenChat = vi.fn(), onOpenRoutine = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = async () => { await act(async () => root!.render(<DesktopWorkspaceRoutines client={createDesktopWorkspaceRoutinesClient()} agentNameOf={() => 'QA copy'} onOpenChat={onOpenChat} onOpenRoutine={onOpenRoutine} docked />)); await settle() }
    await render()
    await openPaused()
    await click('Copied QA routine options'); await click('Run now')
    await vi.waitFor(() => expect(onOpenChat).toHaveBeenCalledOnce())
    const target = onOpenChat.mock.calls[0][0]
    expect(target).toMatchObject({ agentId: 'local-copy', engineSessionId: 'engine-result-session', runId: 'completed-copy-run' })
    expect(target).not.toHaveProperty('engineAgentId')
    const sessions = (await state.db.execute('SELECT * FROM desktop_sessions ORDER BY agent_id')).rows
    expect(sessions).toHaveLength(2)
    expect(sessions.find(row => row.agent_id === 'local-copy')?.id).toBe(target.sessionId)
    expect(sessions.find(row => row.agent_id === 'local-original')?.id).toBe('original-chat')
    // Close and reopen the actual file-backed database while recreating the panel.
    // Terminal engine history must reuse the persisted local tab and original chat.
    await act(async () => root!.unmount()); root = undefined
    state.db.close(); state.db = createClient({ url: databaseUrl })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await render()
    const view = desktopWorkspaceRoutinesViewSchema.parse(await createDesktopWorkspaceRoutinesClient().list())
    expect(view.routines[0]).toMatchObject({ enabled: false, lastResult: { status: 'done', runId: 'completed-copy-run', chat: target } })
    await openPaused()
    await click('Copied QA routine options'); await click('Open result chat')
    expect(onOpenChat).toHaveBeenLastCalledWith(target)
    expect(onOpenRoutine).not.toHaveBeenCalled()
    expect(document.querySelector('input[aria-label="Name"]')).toBeNull()
    expect(state.launches).toBe(1)
    expect((await state.db.execute('SELECT * FROM desktop_sessions')).rows).toHaveLength(2)
})
