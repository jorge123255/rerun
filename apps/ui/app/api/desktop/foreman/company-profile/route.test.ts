import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { profileAttempt, profileChat, profileView, enrichmentIdentity, decisionIdentity } from '@/lib/desktop/company-profile/test-fixtures'
import { createDesktopCompanyProfileClient } from '@/lib/desktop/company-profile/client'
import { DesktopCompanyProfileError } from '@/lib/desktop/server/company-profile/errors'
import { DesktopHttpError } from '@/lib/desktop/server/auth'

const state = vi.hoisted(() => ({ frozen: false, owned: true, profile: null as unknown, runtimeWorkspace: 0 }))
vi.mock('@/lib/desktop/server/http', () => ({
    desktopRoute: async (_request: Request, handler: (runtime: { workspaceId: number }) => Promise<Response>) => {
        try { return await handler({ workspaceId: state.runtimeWorkspace }) }
        catch (error) {
            const status = (error as { status?: number }).status
            if (typeof status === 'number') return Response.json({ error: (error as Error).message }, { status })
            throw error
        }
    },
}))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => ({ db: {} }) }))
vi.mock('@/lib/desktop/server/foreman/chat-store', () => ({ ownedForemanChat: async () => { if (!state.owned) throw new DesktopHttpError(404, 'Conversation not found.') } }))
vi.mock('@/lib/desktop/server/company-profile/binding', () => ({ desktopCompanyProfile: () => state.profile }))
vi.mock('@/lib/desktop/server/workspace-admission', () => ({ assertDesktopWorkspaceAdmission: () => { if (state.frozen) throw new DesktopHttpError(423, 'This workspace is closing.') } }))
import { GET, POST } from './route'

const chat = { ...profileChat, workspaceId: '7' }
const url = 'http://127.0.0.1:3000/api/desktop/foreman/company-profile'
const post = (body: unknown) => POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const get = (query: Record<string, string> = chat) => GET(new Request(`${url}?${new URLSearchParams(query)}`))
function profile() {
    return {
        read: vi.fn(async () => profileView),
        decide: vi.fn(async () => profileAttempt('decide')),
        enrich: vi.fn(async () => profileAttempt('enrich')),
        cancel: vi.fn(async () => profileAttempt('enrich', 'cancelled')),
    }
}
let api: ReturnType<typeof profile>
beforeEach(() => { api = profile(); state.profile = api; state.frozen = false; state.owned = true; state.runtimeWorkspace = 7 })
afterEach(() => vi.unstubAllGlobals())

it('GET reads the saved profile of an owned conversation and starts nothing', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(profileView)
    expect(api.read).toHaveBeenCalledExactlyOnceWith(chat)
    expect(api.decide).not.toHaveBeenCalled()
    expect(api.enrich).not.toHaveBeenCalled()
})

it('refuses another workspace, a conversation that is not owned and a malformed request before touching the profile', async () => {
    expect((await get({ ...chat, workspaceId: '8' })).status).toBe(404)
    expect((await get({ workspaceId: '7' })).status).toBe(400)
    state.owned = false
    expect((await get()).status).toBe(404)
    expect((await post({ action: 'cancel', input: { requestId: randomUUID(), chat } })).status).toBe(404)
    state.owned = true
    expect((await post({ action: 'enrich', input: { requestId: 'not-a-uuid', identity: { ...enrichmentIdentity, chat }, collect: true } })).status).toBe(400)
    expect((await post({ action: 'enrich', input: { requestId: randomUUID(), identity: { ...enrichmentIdentity, chat }, collect: true, url: 'https://elsewhere.invalid' } })).status).toBe(400)
    expect((await post({ action: 'publish', input: {} })).status).toBe(400)
    expect((await post({ action: 'decide', input: { requestId: randomUUID(), identity: { ...decisionIdentity, chat: { ...chat, workspaceId: '8' } } } })).status).toBe(404)
    for (const call of [api.read, api.decide, api.enrich, api.cancel]) expect(call).not.toHaveBeenCalled()
})

it('decide, enrich and cancel pass exactly the validated input to the profile of that conversation', async () => {
    const decide = { requestId: randomUUID(), identity: { ...decisionIdentity, chat } }
    const enrich = { requestId: randomUUID(), identity: { ...enrichmentIdentity, chat }, collect: true }
    const cancel = { requestId: randomUUID(), chat }
    expect(await (await post({ action: 'decide', input: decide })).json()).toEqual(profileAttempt('decide'))
    expect(await (await post({ action: 'enrich', input: enrich })).json()).toEqual(profileAttempt('enrich'))
    expect(await (await post({ action: 'cancel', input: cancel })).json()).toEqual(profileAttempt('enrich', 'cancelled'))
    expect(api.decide.mock.calls[0]![0 as never]).toEqual(decide)
    expect(api.enrich.mock.calls[0]![0 as never]).toEqual(enrich)
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(cancel)
})

it('a closing workspace starts no model call or website read, but a running one can still be stopped', async () => {
    state.frozen = true
    expect((await post({ action: 'decide', input: { requestId: randomUUID(), identity: { ...decisionIdentity, chat } } })).status).toBe(423)
    expect((await post({ action: 'enrich', input: { requestId: randomUUID(), identity: { ...enrichmentIdentity, chat }, collect: true } })).status).toBe(423)
    expect(api.decide).not.toHaveBeenCalled()
    expect(api.enrich).not.toHaveBeenCalled()
    expect((await post({ action: 'cancel', input: { requestId: randomUUID(), chat } })).status).toBe(200)
    expect((await get()).status).toBe(200)
})

it('changed answers, an unknown request and unreadable storage answer with their own status and message', async () => {
    api.enrich.mockRejectedValueOnce(new DesktopCompanyProfileError('stale', 'These company details changed.'))
    const stale = await post({ action: 'enrich', input: { requestId: randomUUID(), identity: { ...enrichmentIdentity, chat }, collect: true } })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'These company details changed.' })
    api.cancel.mockRejectedValueOnce(new DesktopCompanyProfileError('not_found', 'Company profile request not found.'))
    expect((await post({ action: 'cancel', input: { requestId: randomUUID(), chat } })).status).toBe(404)
    api.read.mockRejectedValueOnce(new DesktopCompanyProfileError('storage', 'A saved company profile attempt could not be confirmed.'))
    expect((await get()).status).toBe(503)
})

it('the renderer client that was already written for this address reads and acts through it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => init.method === 'POST'
        ? POST(new Request(`http://127.0.0.1:3000${input}`, { method: 'POST', headers: init.headers, body: init.body }))
        : GET(new Request(`http://127.0.0.1:3000${input}`))))
    const client = createDesktopCompanyProfileClient()
    expect(await client.read(chat)).toEqual(profileView)
    expect((await client.cancel({ requestId: randomUUID(), chat })).status).toBe('cancelled')
    expect((await client.enrich({ requestId: randomUUID(), identity: { ...enrichmentIdentity, chat }, collect: true })).status).toBe('succeeded')
})
