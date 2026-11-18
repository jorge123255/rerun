import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'

const fixture = vi.hoisted(() => ({ runtime: vi.fn(), open: vi.fn() }))
vi.mock('@/lib/desktop/server/runtime', () => ({ readDesktopRuntime: fixture.runtime }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: fixture.open }))
import { GET } from './route'

const runtime: DesktopRuntime = {
    protocolVersion: 1, workspaceId: 1, dataRoot: '/isolated-fixture', launchNonce: '11111111-1111-4111-8111-111111111111', buildId: 'fixture',
    app: { origin: 'http://127.0.0.1:32001', sessionToken: 'fixture-browser-cookie' },
    engine: { origin: 'http://127.0.0.1:32002', apiKey: 'fixture-engine-bearer' },
} as DesktopRuntime
const chat = { workspaceId: '1', chatId: 'fmc_11111111-1111-4111-8111-111111111111' }
const shared = '70000000-0000-4000-8000-000000000001'
const ada = '70000000-0000-4000-8000-000000000002'
let db: Client
function request(ref = chat, cookie = 'rerun-desktop-session=fixture-browser-cookie') {
    return new Request(runtime.app.origin + '/api/desktop/foreman/apps?' + new URLSearchParams(ref), {
        headers: { host: '127.0.0.1:32001', origin: runtime.app.origin, cookie },
    })
}
beforeEach(async () => {
    db = createClient({ url: ':memory:' })
    fixture.runtime.mockResolvedValue(runtime)
    fixture.open.mockResolvedValue(db)
    await db.executeMultiple(`
        CREATE TABLE desktop_foreman_chats(chat_id TEXT, workspace_id TEXT, engine_session_id TEXT, model TEXT, home INTEGER);
        CREATE TABLE desktop_vault_mcp_servers(id TEXT, catalog_slug TEXT, catalog_name TEXT, catalog_label TEXT, shared_with_all INTEGER, sealed TEXT, url TEXT, transport TEXT);
        CREATE TABLE desktop_vault_mcp_attachments(item_id TEXT, agent_id TEXT);
    `)
    await db.execute({ sql: 'INSERT INTO desktop_foreman_chats VALUES(?,?,?,NULL,1)', args: [chat.chatId, chat.workspaceId, 'session'] })
    await db.execute({ sql: "INSERT INTO desktop_vault_mcp_servers VALUES(?, 'linear', 'Linear', 'Team', 1, 'synthetic', 'fixture://team', 'http'), (?, 'linear', 'Linear', 'Ada private', 0, 'synthetic', 'fixture://ada', 'http')", args: [shared, ada] })
    await db.execute("INSERT INTO desktop_vault_mcp_servers VALUES('70000000-0000-4000-8000-000000000003', 'linear', 'Linear', 'Team SSE', 1, 'synthetic', 'fixture://events', 'sse')")
    await db.execute({ sql: 'INSERT INTO desktop_vault_mcp_attachments VALUES(?,?)', args: [ada, 'Ada'] })
})
afterEach(() => {
    db.close()
    setDesktopWorkspaceFrozen(runtime, false)
    vi.clearAllMocks()
})

it('returns only public labels for explicitly everyone-shared catalog accounts and reads the current grant each time', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ chat, apps: [{ id: shared, name: 'Linear', label: 'Team' }] })
    await db.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET catalog_label=NULL WHERE id=?', args: [shared] })
    expect((await (await GET(request())).json()).apps).toEqual([{ id: shared, name: 'Linear', label: null }])
    await db.execute({ sql: 'UPDATE desktop_vault_mcp_servers SET shared_with_all=0 WHERE id=?', args: [shared] })
    expect((await (await GET(request())).json()).apps).toEqual([])
})

it('requires the current desktop browser, matching workspace, and owned Chief chat', async () => {
    expect((await GET(request(chat, ''))).status).toBe(401)
    expect((await GET(request({ ...chat, workspaceId: '2' }))).status).toBe(404)
    expect((await GET(request({ ...chat, chatId: 'fmc_22222222-2222-4222-8222-222222222222' }))).status).toBe(404)
    setDesktopWorkspaceFrozen(runtime, true)
    expect((await GET(request())).status).toBe(409)
})
