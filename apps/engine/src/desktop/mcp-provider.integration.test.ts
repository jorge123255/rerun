import { afterEach, expect, test, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { agentConfigSchema, connectionConfigSchema } from '@rerun/contracts'
import type { RunContext } from '../runtime/context.js'
import type { LoadedAgent } from '../agents/types.js'

const captured = vi.hoisted(() => ({ settings: [] as Record<string, any>[], config: undefined as unknown }))
vi.mock('../config/env.js', () => ({ env: () => ({ RERUN_HUB_BASE_URL: 'http://127.0.0.1:3123', RERUN_API_KEY: 'engine-only', RERUN_DATA_DIR: '/fixture-only', RERUN_LOG_LEVEL: 'silent' }) }))
vi.mock('../agents/lock.js', () => ({ withAgentLock: async (_id: string, action: () => Promise<unknown>) => action() }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => captured.config }))
vi.mock('./agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => () => {} }))
vi.mock('./codex-runtime.js', () => ({ signedInFlag: 'RERUN_CHATGPT_CONNECTED', DESKTOP_CODEX_ID: 'mac-chatgpt', desktopCodexAvailable: () => true, desktopCodexRuntime: () => ({ codexPath: '/fixture/codex', cwd: '/fixture/work', env: {} }) }))
vi.mock('ai-sdk-provider-codex-cli', async original => {
    const actual = await original<typeof import('ai-sdk-provider-codex-cli')>()
    return { ...actual, createCodexAppServer: (options: { defaultSettings: Record<string, any> }) => {
        captured.settings.push(options.defaultSettings)
        return Object.assign((modelId: string) => ({ specificationVersion: 'v3', provider: 'codex', modelId, supportedUrls: {}, doGenerate: vi.fn(), doStream: vi.fn() }), { close: async () => {} })
    } }
})
import { buildTools } from '../tools/registry.js'
import { resolveModel } from '../agents/providers.js'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); captured.settings.length = 0 })
const catalogId = '00000000-0000-4000-8000-000000000001', capabilityId = '00000000-0000-4000-8000-000000000002'
function setup(name = 'public_add') {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const config = agentConfigSchema.parse({ name: 'MCP coworker', provider: 'codex', model: 'fixture', tools: { desktopToolGrants: { mcp: true, workspaceList: true } } })
    captured.config = config
    const agent = {
        id: 'engine-owner', config, soul: '', install: '', env: {},
        resolved: { provider: 'codex', model: 'fixture', connection: { id: 'mac-chatgpt', config: connectionConfigSchema.parse({ name: 'ChatGPT', provider: 'codex', createdAt: '2026-11-04T00:00:00.000Z' }), env: { RERUN_CHATGPT_CONNECTED: '1' } } },
    } as LoadedAgent
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        return Response.json(body.action === 'catalog' ? { catalogId, tools: [{ capabilityId, name, description: 'Public addition', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }] } : { released: true })
    })
    vi.stubGlobal('fetch', fetcher)
    const ctx = { agent, sessionId: 'session', runId: 'run', abortSignal: new AbortController().signal, logger: { warn: vi.fn() } } as unknown as RunContext
    return { agent, ctx, fetcher }
}

test('registry-built MCP tools reach the actual Codex filter, while a copied/prefix-matching tool cannot', async () => {
    const { ctx, agent } = setup()
    const built = await buildTools(ctx)
    const forged = tool({ inputSchema: z.object({}), execute: async () => 'forged' })
    try {
        const tools = { ...built.tools, public_forged: forged, public_copy: { ...built.tools.public_add } }
        const granted = resolveModel(agent, undefined, tools)
        const names = captured.settings.at(-1)!.mcpServers.rerun.tools.map((entry: { name: string }) => entry.name)
        expect(names).toContain('public_add')
        expect(names).toContain('fs_list')
        expect(names).not.toContain('public_forged')
        expect(names).not.toContain('public_copy')
        await granted.close()
        agent.config.tools.desktopToolGrants = { workspaceList: true, mcp: false }
        const denied = resolveModel(agent, undefined, tools)
        expect(captured.settings.at(-1)!.mcpServers.rerun.tools.map((entry: { name: string }) => entry.name)).not.toContain('public_add')
        await denied.close()
    } finally { await built.close() }
})

test('registry rejects an MCP name colliding with an existing built-in and releases its catalog', async () => {
    const { ctx, fetcher } = setup('fs_list')
    await expect(buildTools(ctx)).rejects.toThrow('conflicts with a built-in')
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)).action)).toEqual(['catalog', 'release'])
})

test('the legal tool name formed by server _ and remote tool proto__ survives registry and both Codex bridge filters', async () => {
    const name = `${'_'}_${'proto__'}`
    expect(name).toBe('__proto__')
    const { ctx, agent } = setup(name)
    const built = await buildTools(ctx)
    try {
        expect(Object.hasOwn(built.tools, name)).toBe(true)
        expect(Object.getPrototypeOf(built.tools)).toBe(Object.prototype)
        const resolved = resolveModel(agent, undefined, built.tools)
        expect(captured.settings.at(-1)!.mcpServers.rerun.tools.map((entry: { name: string }) => entry.name)).toContain('__proto__')
        await resolved.close()
    } finally { await built.close() }
})
