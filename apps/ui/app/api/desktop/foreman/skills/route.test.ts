import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'

const f = vi.hoisted(() => ({ runtime: vi.fn(), open: vi.fn(), list: vi.fn(), summaries: vi.fn(), get: vi.fn(), network: vi.fn(), agent: vi.fn() }))
vi.mock('@/lib/desktop/server/runtime', () => ({ readDesktopRuntime: f.runtime }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: f.open }))
vi.mock('@/lib/desktop/server/settings', () => ({ engineOf: (r: DesktopRuntime) => ({ baseUrl: r.engine.origin, apiKey: r.engine.apiKey }) }))
vi.mock('@/lib/engine/client', async original => ({ ...await original<typeof import('@/lib/engine/client')>(), listSkillSummaries: f.summaries, getSkill: f.get, getAgent: f.agent }))
import { GET, POST } from './route'
import { handleDesktopServiceSkillOwners } from '@/lib/desktop/server/service-skills/bridge'

const runtime = { workspaceId: 1, dataRoot: '/synthetic', launchNonce: 'launch-1', engine: { origin: 'http://127.0.0.1:51231', apiKey: 'test-engine' },
    app: { origin: 'http://127.0.0.1:51232', sessionToken: 'test-session' } } as DesktopRuntime
const chat = { workspaceId: '1', chatId: 'fmc_11111111-1111-4111-8111-111111111111' }
const otherChat = { workspaceId: '1', chatId: 'fmc_22222222-2222-4222-8222-222222222222' }
const skill = { slug: 'brief', name: 'Brief', description: 'Draft a brief.' }
const proposal = { id: 'p1', sessionId: 's1', toolCallId: 'call1', mode: 'create', slug: null, title: 'Brief',
    revision: 'b'.repeat(64), summary: 'Create a short brief.', instructions: ['Use one heading.'], status: 'proposed', appliedSlug: null, error: null, createdAt: '2026-11-18T12:00:00Z' }
const headers = { host: '127.0.0.1:51232', origin: runtime.app.origin, cookie: 'rerun-desktop-session=test-session', 'content-type': 'application/json' }
const endpoint = runtime.app.origin + '/api/desktop/foreman/skills'
const get = (ref = chat, slug = '', cookie = headers.cookie) => GET(new Request(endpoint + '?' + new URLSearchParams({ ...ref, ...(slug && { slug }) }), { headers: { ...headers, cookie } }))
const post = (ref = chat, decision = 'accept', revision = proposal.revision) => POST(new Request(endpoint, { method: 'POST', headers,
    body: JSON.stringify({ chat: ref, proposalId: 'p1', decision, revision }) }))
let db: Client
beforeEach(async () => {
    vi.resetAllMocks()
    db = createClient({ url: ':memory:' })
    f.open.mockResolvedValue(db)
    f.runtime.mockResolvedValue(runtime)
    f.agent.mockResolvedValue({ id: 'foreman', config: { kind: 'foreman', enabled: true } })
    f.summaries.mockResolvedValue([skill])
    f.list.mockImplementation((session: string) => Promise.resolve(session === 's1' ? [proposal] : []))
    f.network.mockImplementation(async (url: string, init: RequestInit) => {
        const endpoint = new URL(url)
        if (init.method === 'GET') return Response.json({ proposals: await f.list(endpoint.searchParams.get('session')) })
        if (endpoint.searchParams.get('session') !== 's1') return Response.json({ error: 'Session mismatch' }, { status: 404 })
        if (new Headers(init.headers).get('if-match') !== '"' + proposal.revision + '"') return Response.json({ error: 'Proposal changed' }, { status: 409 })
        return Response.json({ proposal: { ...proposal, status: endpoint.pathname.endsWith('/accept') ? 'accepted' : 'dismissed' } })
    })
    vi.stubGlobal('fetch', f.network)
    await db.executeMultiple('CREATE TABLE desktop_foreman_chats(chat_id TEXT,workspace_id TEXT,engine_session_id TEXT,model TEXT,home INTEGER)')
    await db.execute({ sql: "INSERT INTO desktop_foreman_chats VALUES(?,'1','s1',NULL,1),(?,'1','s2',NULL,0)", args: [chat.chatId, otherChat.chatId] })
})
afterEach(() => { setDesktopWorkspaceFrozen(runtime, false); db.close(); vi.unstubAllGlobals() })

it('lists installed skills and actual decisions separately for each owned chat', async () => {
    const first = await get()
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(await first.json()).toEqual({ chat, skills: [skill], proposals: [proposal] })
    expect(await (await get(otherChat)).json()).toEqual({ chat: otherChat, skills: [skill], proposals: [] })
    f.get.mockResolvedValue({ ...skill, body: 'Use one heading.', files: ['private-server-field'] })
    expect(await (await get(chat, 'brief')).json()).toEqual({ chat, skill: { ...skill, body: 'Use one heading.' } })
})

it('decides only the exact proposal and session; accepted, applied and dismissed statuses come from the engine', async () => {
    expect((await post(otherChat)).status).toBe(404)
    expect(new URL(f.network.mock.calls[0][0]).searchParams.get('session')).toBe('s2')
    expect((await post(chat, 'accept', 'a'.repeat(64))).status).toBe(409)
    for (const [decision, status] of [['accept','accepted'], ['accept','applied'], ['dismiss','dismissed']]) {
        const settled = { ...proposal, status }
        f.network.mockResolvedValueOnce(Response.json({ proposal: settled }))
        expect(await (await post(chat, decision)).json()).toEqual({ chat, proposal: settled })
        const [url, init] = f.network.mock.lastCall!
        expect(url).toBe(runtime.engine.origin + '/agents/foreman/skill-proposals/p1/' + decision + '?session=s1')
        expect(new Headers(init.headers).get('If-Match')).toBe('"' + proposal.revision + '"')
    }
    f.network.mockResolvedValueOnce(Response.json({ proposal: { ...proposal, sessionId: 's2' } }))
    expect((await post()).status).toBe(502)
})

it('rejects foreign or stale workspaces, disabled or ephemeral identities and unowned skills', async () => {
    expect((await get(chat, '', '')).status).toBe(401)
    expect((await post({ ...chat, workspaceId: '2' })).status).toBe(404)
    expect(f.agent).not.toHaveBeenCalled()
    f.agent.mockResolvedValueOnce({ id: 'foreman', config: { kind: 'agent', enabled: true } })
    expect((await post()).status).toBe(409)
    f.agent.mockResolvedValueOnce({ id: 'foreman', config: { kind: 'foreman', enabled: true, ephemeral: true } })
    expect((await get()).status).toBe(409)
    f.agent.mockResolvedValueOnce({ id: 'foreman', config: { kind: 'foreman', enabled: false } })
    expect((await post()).status).toBe(409)
    expect((await get(chat, 'svc-hidden')).status).toBe(404)
    expect(f.get).not.toHaveBeenCalled()
    f.list.mockResolvedValueOnce([{ ...proposal, sessionId: 's2' }])
    expect((await get()).status).toBe(502)
    f.runtime.mockResolvedValueOnce(runtime).mockResolvedValue({ ...runtime, launchNonce: 'new-launch' })
    expect((await post()).status).toBe(409)
    expect(f.network.mock.calls.filter(([,init]) => init.method === 'POST')).toHaveLength(0)
})

it('resolves only the managed Chief through the authenticated internal skill ownership callback', async () => {
    const call = (syncVault: boolean, token = 'test-engine') => handleDesktopServiceSkillOwners(new Request(runtime.app.origin + '/api/desktop/internal/service-skills',
        { method: 'POST', headers: { host: headers.host, authorization: 'Bearer ' + token }, body: JSON.stringify({ engineAgentId: 'foreman', ...(syncVault && { syncVault: true }) }) }))
    expect((await call(false,'bad')).status).toBe(401)
    expect(await (await call(true)).json()).toEqual({ engineAgentId: 'foreman', hidden: [] })
    expect(await (await call(false)).json()).toEqual({ engineAgentId: 'foreman', owners: [] })
    setDesktopWorkspaceFrozen(runtime, true)
    expect((await call(true)).status).toBe(409)
    expect((await get()).status).toBe(409)
})
