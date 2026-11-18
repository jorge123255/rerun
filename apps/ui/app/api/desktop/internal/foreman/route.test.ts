import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test, vi } from 'vitest'
import { foremanDiscoveryRunSchema, type DesktopForemanBinding } from '@rerun/contracts'
import { createForemanRuntime, type ForemanRuntime } from '@/lib/desktop/server/foreman/runtime'
import { fakeAuthorities, memoryForemanStore } from '@/lib/desktop/server/foreman/runtime.test-support'

type DiscoveryBridge = { request(input: { action: 'discover'; binding: DesktopForemanBinding; url: string }): Promise<unknown>; close(): void }
type BridgeModule = { createDesktopForemanBridge(runtime: typeof appRuntime, network: typeof fetch): DiscoveryBridge }
const bridgePath = new URL('../../../../../../engine/src/desktop/foreman/bridge.ts', import.meta.url).href

const mounted = vi.hoisted(() => ({ core: null as ForemanRuntime | null, db: null as Client | null, live: true, snapshot: vi.fn(), setup: vi.fn() }))
const appRuntime = vi.hoisted(() => ({ workspaceId: 1, launchNonce: '00000000-0000-4000-8000-000000000001', app: { origin: 'http://127.0.0.1:44000' }, engine: { apiKey: 'a'.repeat(64) } }))
vi.mock('@/lib/desktop/server/auth', async original => ({ ...await original<typeof import('@/lib/desktop/server/auth')>(), authenticateDesktopEngineRequest: async () => appRuntime }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => ({ core: mounted.core, db: mounted.db, isLive: async () => mounted.live }) }))
vi.mock('@/lib/desktop/server/foreman-voice/binding', () => ({ desktopForemanVoice: () => { throw new Error('Discovery must not create a voice runtime.') } }))
vi.mock('@/lib/desktop/server/foreman-workspace-reads', () => ({ readGrantedForemanWorkspaceSnapshot: mounted.snapshot }))
vi.mock('@/lib/desktop/server/foreman/setup-coordination', () => ({ inspectChiefSetup: mounted.setup }))
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { POST } from './route'

afterEach(() => { mounted.core = null; mounted.db = null; mounted.live = true; mounted.snapshot.mockReset(); mounted.setup.mockReset() })

test('the workspace snapshot callback refuses stale launches and checks the run again after the read', async () => {
    const binding: DesktopForemanBinding = { workspaceId: '1', chatId: 'fmc_callback0001', runId: '00000000-0000-4000-8000-000000000002', model: { connectionId: 'local', model: 'model' } }
    const snapshot = (launchNonce = appRuntime.launchNonce) => POST(new Request(appRuntime.app.origin + '/api/desktop/internal/foreman', {
        method: 'POST', body: JSON.stringify({ action: 'workspace_snapshot', binding, launchNonce }),
    }))
    expect((await snapshot('stale')).status).toBe(409)
    expect(mounted.snapshot).not.toHaveBeenCalled()
    mounted.snapshot.mockImplementationOnce(async () => { mounted.live = false; return { kind: 'ready' } })
    const stopped = await snapshot()
    expect(stopped.status).toBe(409)
    expect(await stopped.json()).not.toHaveProperty('kind')
    mounted.live = true
    mounted.snapshot.mockResolvedValueOnce({ kind: 'ready' })
    const live = await snapshot()
    expect(live.status).toBe(200)
    expect(live.headers.get('cache-control')).toBe('no-store')
    expect(mounted.snapshot).toHaveBeenLastCalledWith(appRuntime, '1', expect.any(AbortSignal))
})

test('the production discovery callback returns its completed saved result through the engine bridge', async () => {
    const binding: DesktopForemanBinding = { workspaceId: '1', chatId: 'fmc_callback0001', runId: '00000000-0000-4000-8000-000000000002', model: { connectionId: 'mac-chatgpt', model: 'gpt-6.1-terra' } }
    const fake = fakeAuthorities()
    fake.authorities.workspace.currentWorkspaceId = async () => binding.workspaceId
    fake.authorities.run.isLive = async candidate => mounted.live && candidate.runId === binding.runId
    fake.authorities.run.currentLive = async () => ({ runId: binding.runId, model: binding.model })
    fake.authorities.collectDiscovery = async ({ emit }) => {
        emit({ type: 'found', source: 'site', findings: [{ kind: 'identity', source: 'site', attribution: { url: 'https://acme.example/', fetchedAt: '2026-11-06T00:00:00.000Z' }, name: 'Acme', oneLiner: 'Public web software', domain: 'acme.example', logoUrl: null }] })
        emit({ type: 'end' })
    }
    mounted.core = createForemanRuntime({ store: memoryForemanStore(), authorities: fake.authorities, companyName: async () => 'Local workspace' })
    const network: typeof fetch = async (input, init) => POST(new Request(input, init))
    const bridgeModule: unknown = await import(/* @vite-ignore */ bridgePath)
    const bridge = (bridgeModule as BridgeModule).createDesktopForemanBridge(appRuntime, network)
    try {
        const result = foremanDiscoveryRunSchema.parse(await bridge.request({ action: 'discover', binding, url: 'https://acme.example/' }))
        expect(result).toMatchObject({ chat: { workspaceId: binding.workspaceId, chatId: binding.chatId }, runId: binding.runId, status: 'done', findings: [{ kind: 'identity', name: 'Acme' }] })
        expect((await mounted.core.readView({ workspaceId: binding.workspaceId, chatId: binding.chatId })).discovery).toEqual(result)
    } finally { bridge.close() }
})


test('inspection returns a safe contact hint, withholds the question after Stop and refuses stale launches', async () => {
    const binding: DesktopForemanBinding = { workspaceId: '1', chatId: 'fmc_callback0001', runId: '00000000-0000-4000-8000-000000000002', model: { connectionId: 'local', model: 'model' } }
    const read = (launchNonce = appRuntime.launchNonce) => POST(new Request(appRuntime.app.origin + '/api/desktop/internal/foreman', {
        method: 'POST', body: JSON.stringify({ action: 'inspect_setup', coworker: 'QA tester', binding, launchNonce }),
    }))
    expect((await read('old')).status).toBe(409)
    expect(mounted.setup).not.toHaveBeenCalled()
    mounted.setup.mockRejectedValueOnce(new DesktopHttpError(403, 'fixture-private-detail'))
    const denied = await read()
    expect(await denied.json()).toEqual({ state: 'contact_unavailable', reason: expect.stringContaining('Call coworkers') })
    mounted.setup.mockImplementationOnce(async () => { mounted.live = false; return { lastMessage: 'Private to this run' } })
    const stopped = await read()
    expect(stopped.status).toBe(409)
    expect(await stopped.json()).not.toHaveProperty('lastMessage')
    mounted.live = true
    mounted.setup.mockResolvedValueOnce({ state: 'awaiting_reply', lastMessage: 'What platform?' })
    const permitted = await read()
    expect(permitted.status).toBe(200)
    expect(permitted.headers.get('cache-control')).toBe('no-store')
    expect(await permitted.json()).toMatchObject({ state: 'awaiting_reply', lastMessage: 'What platform?' })
})

test('only shared HTTP catalog apps enable tools for the exact live Chief binding', async () => {
    const db = createClient({url:'file::memory:'})
    mounted.db = db
    const binding = {workspaceId:'1',chatId:'fmc_callback0001',runId:'00000000-0000-4000-8000-000000000002',model:{connectionId:'local',model:'fixture'}}
    const post = (sessionId = 'chat') => POST(new Request(appRuntime.app.origin + '/api/desktop/internal/foreman', {
        method:'POST',body:JSON.stringify({action:'binding',launchNonce:appRuntime.launchNonce,identity:{engineAgentId:'foreman',sessionId,runId:binding.runId}}),
    }))
    try {
        await db.executeMultiple(`CREATE TABLE desktop_foreman_turns(request_id TEXT,body TEXT,fingerprint TEXT,status TEXT);
            CREATE TABLE desktop_vault_mcp_servers(shared_with_all INTEGER,catalog_slug TEXT,transport TEXT);
            INSERT INTO desktop_vault_mcp_servers VALUES(0,'linear','http'),(1,NULL,'http'),(1,'linear','sse');`)
        await db.execute({sql:"INSERT INTO desktop_foreman_turns VALUES(?,?,'identity','admitted')",args:[binding.runId,JSON.stringify({binding,sessionId:'chat'})]})
        expect(await (await post()).json()).toEqual({binding,discovery:true})
        await db.execute("UPDATE desktop_vault_mcp_servers SET shared_with_all=1 WHERE catalog_slug='linear' AND transport='http'")
        expect(await (await post()).json()).toEqual({binding,discovery:true,sharedVaultApps:true})
        expect((await post('foreign')).status).toBe(409)
        mounted.live = false
        expect((await post()).status).toBe(409)
    } finally { db.close() }
})
