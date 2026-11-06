import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RunContext } from '../../runtime/context.js'
const state = vi.hoisted(() => ({ running: true, owned: true }))
vi.mock('../../agents/registry.js', () => ({ getAgent: async () => ({ id: 'foreman', config: { kind: 'foreman', enabled: true } }) }))
vi.mock('../../db/repos/sessions.js', () => ({ getSession: async () => ({ id: 'session', agentId: state.owned ? 'foreman' : 'sibling', source: 'dashboard', status: 'open', originAgentId: null, originSessionId: null }) }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: async () => ({ id: 'run', agentId: 'foreman', sessionId: 'session', status: state.running ? 'running' : 'cancelled' }) }))
import { bindDesktopForeman, desktopForemanTools } from './binding.js'
const runtime = { launchNonce: '00000000-0000-4000-8000-000000000001', app: { origin: 'http://127.0.0.1:44000' }, engine: { apiKey: 'a'.repeat(64) } }
const binding = { workspaceId: '1', chatId: 'fmc_chat-0001', runId: 'run', model: { connectionId: 'conn', model: 'model' } }
const context = () => ({ agent: { id: 'foreman', config: { kind: 'foreman' }, resolved: { connection: { id: 'conn' }, model: 'model' } }, sessionId: 'session', runId: 'run', model: 'model', abortSignal: new AbortController().signal }) as unknown as RunContext
let stop: (() => void) | undefined
beforeEach(() => { vi.stubEnv('RERUN_DESKTOP_APP', '1'); state.running = true; state.owned = true })
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllEnvs() })
function connect(network: typeof fetch) { const wired = bindDesktopForeman(runtime, network); stop = wired.close; return wired }
test('trusted server binding exposes only reviewed tools and ignores renderer-style context fields', async () => {
    const actions: unknown[] = []
    const network = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); actions.push(body); return Response.json(body.action === 'binding' ? { binding, discovery: false } : { ok: true }) }) as typeof fetch
    connect(network)
    const ctx = { ...context(), binding: { ...binding, chatId: 'forged-chat' } }
    const tools = await desktopForemanTools(ctx)
    expect(Object.keys(tools.tools)).toEqual(['show_plan', 'open_panel', 'search_docs'])
    await tools.tools.show_plan!.execute!({ title: 'A team', boxes: [], items: [] } as never, { toolCallId: 'call-exact', messages: [] })
    expect(actions[1]).toMatchObject({ action: 'show_plan', binding, toolCallId: 'call-exact', launchNonce: runtime.launchNonce })
})
test('stopped or remapped sessions never deliver tools; a changed model never gets a catalog', async () => {
    const network = vi.fn(async () => Response.json({ binding: { ...binding, model: { ...binding.model, model: 'other' } }, discovery: false })) as typeof fetch
    connect(network)
    await expect(desktopForemanTools(context())).rejects.toThrow('model')
    state.running = false
    await expect(desktopForemanTools(context())).rejects.toThrow('active')
    state.running = true; state.owned = false
    await expect(desktopForemanTools(context())).rejects.toThrow('active')
    expect(network).toHaveBeenCalledTimes(1)
})
test('late completion after Stop is refused and cannot become a valid tool acknowledgement', async () => {
    connect(vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        if (body.action === 'binding') return Response.json({ binding, discovery: false })
        state.running = false; return Response.json({ ok: true })
    }) as typeof fetch)
    const { tools } = await desktopForemanTools(context())
    await expect(tools.show_plan!.execute!({ title: 'Team', boxes: [], items: [] } as never, { toolCallId: 'exact', messages: [] })).rejects.toThrow('active')
})
test('an old tool closure cannot cross a desktop binding replacement', async () => {
    const network = vi.fn(async () => Response.json({ binding, discovery: false })) as typeof fetch
    connect(network); const { tools } = await desktopForemanTools(context())
    connect(network)
    await expect(tools.open_panel!.execute!({} as never, { toolCallId: 'exact', messages: [] })).rejects.toThrow('launch')
    expect(network).toHaveBeenCalledTimes(1)
})
