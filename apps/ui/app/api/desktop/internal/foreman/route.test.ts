import { afterEach, expect, test, vi } from 'vitest'
import { foremanDiscoveryRunSchema, type DesktopForemanBinding } from '@rerun/contracts'
import { createForemanRuntime, type ForemanRuntime } from '@/lib/desktop/server/foreman/runtime'
import { fakeAuthorities, memoryForemanStore } from '@/lib/desktop/server/foreman/runtime.test-support'

type DiscoveryBridge = { request(input: { action: 'discover'; binding: DesktopForemanBinding; url: string }): Promise<unknown>; close(): void }
type BridgeModule = { createDesktopForemanBridge(runtime: typeof appRuntime, network: typeof fetch): DiscoveryBridge }
const bridgePath = new URL('../../../../../../engine/src/desktop/foreman/bridge.ts', import.meta.url).href

const mounted = vi.hoisted(() => ({ core: null as ForemanRuntime | null, live: true }))
const appRuntime = vi.hoisted(() => ({ workspaceId: 1, launchNonce: '00000000-0000-4000-8000-000000000001', app: { origin: 'http://127.0.0.1:44000' }, engine: { apiKey: 'a'.repeat(64) } }))
vi.mock('@/lib/desktop/server/auth', async original => ({ ...await original<typeof import('@/lib/desktop/server/auth')>(), authenticateDesktopEngineRequest: async () => appRuntime }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => ({ core: mounted.core, isLive: async () => mounted.live }) }))
vi.mock('@/lib/desktop/server/foreman-voice/binding', () => ({ desktopForemanVoice: () => { throw new Error('Discovery must not create a voice runtime.') } }))
import { POST } from './route'

afterEach(() => { mounted.core = null; mounted.live = true })

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
