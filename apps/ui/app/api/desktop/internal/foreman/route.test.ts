import { afterEach, expect, test, vi } from 'vitest'
import { foremanDiscoveryRunSchema, type DesktopForemanBinding } from '@rerun/contracts'
import { createForemanRuntime, type ForemanRuntime } from '@/lib/desktop/server/foreman/runtime'
import { fakeAuthorities, memoryForemanStore } from '@/lib/desktop/server/foreman/runtime.test-support'

type DiscoveryBridge = { request(input: { action: 'discover'; binding: DesktopForemanBinding; url: string }): Promise<unknown>; close(): void }
type BridgeModule = { createDesktopForemanBridge(runtime: typeof appRuntime, network: typeof fetch): DiscoveryBridge }
const bridgePath = new URL('../../../../../../engine/src/desktop/foreman/bridge.ts', import.meta.url).href

const mounted = vi.hoisted(() => ({ core: null as ForemanRuntime | null, live: true, snapshot: vi.fn() }))
const appRuntime = vi.hoisted(() => ({ workspaceId: 1, launchNonce: '00000000-0000-4000-8000-000000000001', app: { origin: 'http://127.0.0.1:44000' }, engine: { apiKey: 'a'.repeat(64) } }))
vi.mock('@/lib/desktop/server/auth', async original => ({ ...await original<typeof import('@/lib/desktop/server/auth')>(), authenticateDesktopEngineRequest: async () => appRuntime }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => ({ core: mounted.core, isLive: async () => mounted.live }) }))
vi.mock('@/lib/desktop/server/foreman-voice/binding', () => ({ desktopForemanVoice: () => { throw new Error('Discovery must not create a voice runtime.') } }))
vi.mock('@/lib/desktop/server/foreman-workspace-reads', () => ({ readGrantedForemanWorkspaceSnapshot: mounted.snapshot }))
import { POST } from './route'

afterEach(() => { mounted.core = null; mounted.live = true; mounted.snapshot.mockReset() })

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
