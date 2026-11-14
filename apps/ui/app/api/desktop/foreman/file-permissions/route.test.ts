import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { coworkerToolCatalogs } from '@/lib/desktop/coworker-tools'

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), db: vi.fn(), owned: vi.fn() }))
vi.mock('@/lib/desktop/server/runtime', () => ({ readDesktopRuntime: mocks.runtime }))
vi.mock('@/lib/desktop/server/database', () => ({ openDesktopDatabase: mocks.db }))
vi.mock('@/lib/desktop/server/foreman/chat-store', () => ({ ownedForemanChat: mocks.owned }))
import { GET, PATCH } from './route'

const runtime = {
    protocolVersion: 1, workspaceId: 1, dataRoot: '/isolated-fixture', launchNonce: '11111111-1111-4111-8111-111111111111', buildId: 'fixture',
    app: { origin: 'http://127.0.0.1:32001', sessionToken: 'fixture-browser-cookie' }, engine: { origin: 'http://127.0.0.1:32002', apiKey: 'fixture-engine-bearer' },
} as DesktopRuntime
const chat = { workspaceId: '1', chatId: 'fmc_11111111-1111-4111-8111-111111111111' }
const off = { foremanAgentFilesRead: false, foremanAgentFilesWrite: false }
const snapshot = { workspaceId: '1', launchNonce: runtime.launchNonce, grants: off }
const body = { chat, launchNonce: runtime.launchNonce, expectedGrants: off, id: 'foremanAgentFilesRead', enabled: true }
function request(method = 'GET', input: unknown = body, headers: Record<string, string> = {}) {
    const query = method === 'GET' ? `?${new URLSearchParams(chat)}` : ''
    return new Request(`${runtime.app.origin}/api/desktop/foreman/file-permissions${query}`, { method,
        headers: { host: '127.0.0.1:32001', origin: runtime.app.origin, cookie: 'rerun-desktop-session=fixture-browser-cookie', 'content-type': 'application/json', ...headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    })
}
beforeEach(() => {
    vi.resetAllMocks()
    mocks.runtime.mockResolvedValue(runtime)
    mocks.db.mockResolvedValue({})
    mocks.owned.mockImplementation(async (_db, value) => { if (value.chatId !== chat.chatId) throw new DesktopHttpError(404, 'Foreman conversation not found.') })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)))
})
afterEach(() => { vi.unstubAllGlobals() })

test('Foreman permission endpoint preserves cookie/origin/owner and launch fences', async () => {
    expect((await GET(request('GET', undefined, { cookie: '' }))).status).toBe(401)
    expect((await PATCH(request('PATCH', body, { origin: 'https://other.invalid' }))).status).toBe(403)
    expect((await PATCH(request('PATCH', { ...body, chat: { ...chat, workspaceId: '2' } }))).status).toBe(404)
    expect((await PATCH(request('PATCH', { ...body, chat: { ...chat, chatId: 'fmc_22222222-2222-4222-8222-222222222222' } }))).status).toBe(404)
    expect((await PATCH(request('PATCH', { ...body, launchNonce: '22222222-2222-4222-8222-222222222222' }))).status).toBe(409)
    expect((await PATCH(request('PATCH', { ...body, id: 'mcp' }))).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
})

test('only the dedicated Foreman UI exposes these grants; proxy response contains no private bearer', async () => {
    expect(coworkerToolCatalogs.rerun.some(row => ['foremanAgentFilesRead', 'foremanAgentFilesWrite', 'foremanWorkspaceRead'].includes(row.id))).toBe(false)
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(snapshot)
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer fixture-engine-bearer' })
    fetchMock.mockRejectedValueOnce(new Error('Lost acknowledgement'))
    expect((await PATCH(request('PATCH'))).status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('the managed Foreman route forwards a revision-checked delegation opt-in without changing file grants', async () => {
    const expectedGrants = { ...off, delegate: false }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...snapshot, grants: { ...off, delegate: true } }))
    const response = await PATCH(request('PATCH', { ...body, id: 'delegate', expectedGrants }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ grants: { ...off, delegate: true } })
    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toMatchObject({ workspaceId: chat.workspaceId, id: 'delegate', enabled: true, expectedGrants })
})

test('the managed Foreman route forwards the workspace metadata opt-in with the prior value', async () => {
    const expectedGrants = { ...off, foremanWorkspaceRead: false }
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...snapshot, grants: { ...off, foremanWorkspaceRead: true } }))
    const response = await PATCH(request('PATCH', { ...body, id: 'foremanWorkspaceRead', expectedGrants }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ grants: { ...off, foremanWorkspaceRead: true } })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({
        workspaceId: chat.workspaceId, id: 'foremanWorkspaceRead', enabled: true, expectedGrants,
    })
})
