import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'

const state = vi.hoisted(() => ({ db: null as unknown as Client, discoveryClose: vi.fn(), open: vi.fn() }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => { state.open(); return state.db } }))
vi.mock('../settings', () => ({ engineOf: vi.fn(), readDesktopProviders: vi.fn(), desktopModel: vi.fn() }))
vi.mock('../spaces', () => ({ readDesktopBoardState: vi.fn() }))
vi.mock('../store', () => ({ listDesktopAgents: vi.fn() }))
vi.mock('../workspace-admission', () => ({ assertDesktopWorkspaceAdmission: vi.fn(async () => {}), desktopWorkspaceFrozen: () => false }))
vi.mock('./creation', () => ({ createDesktopForemanCreationAuthority: async () => ({ creation: {}, setup: {} }) }))
vi.mock('./server', () => ({ openForemanRuntime: () => ({ reconcile: async () => {} }) }))
vi.mock('../company-discovery', () => ({
    createCompanyDiscoverySqliteStore: vi.fn(),
    createCompanyDiscoveryRuntime: () => ({ reconcile: async () => {}, close: state.discoveryClose }),
    CompanyDiscoveryError: class extends Error {},
}))
vi.mock('../../../../../engine/src/desktop/company-discovery/index.ts', () => ({ confinedCompanyDns: vi.fn(), confinedCompanyReader: vi.fn(), runCompanyCollectors: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({
    request: vi.fn(async (_engine, _path, _init, parse) => parse({ question: null })), EngineRequestError: class extends Error {}, cancelRun: vi.fn(), getRun: vi.fn(), getSessionMessages: vi.fn() }))
vi.mock('@/lib/chat/engine-history', () => ({ publicDesktopHistory: vi.fn(), transformEngineMessages: vi.fn() }))
import { desktopForeman, shutdownDesktopForeman } from './binding'

let runtime: DesktopRuntime
beforeEach(async () => {
    vi.clearAllMocks()
    state.discoveryClose.mockResolvedValue(undefined)
    state.db = createClient({ url: ':memory:' })
    await state.db.executeMultiple('CREATE TABLE desktop_foreman_chats(workspace_id TEXT,chat_id TEXT); INSERT INTO desktop_foreman_chats VALUES(\'1\',\'saved-foreman-chat\');')
    runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: randomUUID(), buildId: 'shutdown-test', dataRoot: '/isolated-foreman-shutdown-test',
        app: { origin: 'http://127.0.0.1:3210', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'b'.repeat(64) } }
})
afterEach(() => { state.db.close(); vi.unstubAllGlobals() })

test('native preflight success is reused after engine IPC Stop closes engine HTTP admission', async () => {
    let stopping = false
    const engine = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(`${runtime.engine.origin}/desktop/company-brief/cancel-chat`)
        expect(JSON.parse(String(init.body))).toEqual({ workspaceId: '1', chatId: 'saved-foreman-chat' })
        return Response.json(stopping ? { error: 'Engine is stopping' } : { ok: true }, { status: stopping ? 503 : 200 })
    })
    vi.stubGlobal('fetch', engine)
    // Use the real production binding and company-brief HTTP adapter. Only unrelated
    // model/creation/discovery preparation is replaced, and no turn is sent.
    const binding = await desktopForeman(runtime)
    await shutdownDesktopForeman(runtime)
    expect(binding.voiceShutdownSignal.aborted).toBe(true)
    expect(engine).toHaveBeenCalledOnce()
    stopping = true
    await expect(shutdownDesktopForeman(runtime)).resolves.toBeUndefined()
    expect(engine).toHaveBeenCalledOnce()
    expect(state.discoveryClose).toHaveBeenCalledOnce()
    expect(state.open).toHaveBeenCalledOnce()
})

test('concurrent shutdowns share the in-flight drain, and a failed attempt remains retryable', async () => {
    let release!: () => void
    const pending = new Promise<void>(done => { release = done })
    let accepted = false
    const engine = vi.fn(async () => {
        await pending
        return Response.json(accepted ? { ok: true } : { error: 'Temporarily unavailable' }, { status: accepted ? 200 : 503 })
    })
    vi.stubGlobal('fetch', engine)
    await desktopForeman(runtime)
    const first = shutdownDesktopForeman(runtime), second = shutdownDesktopForeman(runtime)
    const outcomes = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(engine).toHaveBeenCalledOnce())
    expect(state.discoveryClose).toHaveBeenCalledOnce()
    release()
    expect((await outcomes).map(item => item.status)).toEqual(['rejected', 'rejected'])
    accepted = true
    await expect(shutdownDesktopForeman(runtime)).resolves.toBeUndefined()
    expect(engine).toHaveBeenCalledTimes(2)
    expect(state.discoveryClose).toHaveBeenCalledTimes(2)
    await shutdownDesktopForeman(runtime)
    expect(engine).toHaveBeenCalledTimes(2)
})

test('a confirmed drain is scoped to its binding and shutdown never creates another binding', async () => {
    const engine = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', engine)
    await shutdownDesktopForeman(runtime)
    expect(state.open).not.toHaveBeenCalled()
    expect(engine).not.toHaveBeenCalled()
    await desktopForeman(runtime)
    await shutdownDesktopForeman(runtime)
    const nextLaunch = { ...runtime, launchNonce: randomUUID() }
    await shutdownDesktopForeman(nextLaunch)
    expect(state.open).toHaveBeenCalledOnce()
    await desktopForeman(nextLaunch)
    await shutdownDesktopForeman(nextLaunch)
    expect(engine).toHaveBeenCalledTimes(2)
    expect(state.open).toHaveBeenCalledTimes(2)
})
