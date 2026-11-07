import { afterEach, expect, test, vi } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { agentConfigSchema, connectionConfigSchema } from '@rerun/contracts'
import type { RunContext } from '../runtime/context.js'
import type { LoadedAgent } from '../agents/types.js'

const captured = vi.hoisted(() => ({ settings: [] as Record<string, any>[], claude: [] as Record<string, any>[], config: undefined as unknown, generate: vi.fn(), stream: vi.fn() }))
vi.mock('../config/env.js', () => ({ env: () => ({ RERUN_HUB_BASE_URL: 'http://127.0.0.1:3123', RERUN_API_KEY: 'engine-only', RERUN_DATA_DIR: '/fixture-only', RERUN_LOG_LEVEL: 'silent' }) }))
vi.mock('../agents/lock.js', () => ({ withAgentLock: async (_id: string, action: () => Promise<unknown>) => action() }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => captured.config }))
vi.mock('./agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => () => {} }))
vi.mock('./codex-runtime.js', () => ({ signedInFlag: 'RERUN_CHATGPT_CONNECTED', DESKTOP_CODEX_ID: 'mac-chatgpt', desktopCodexAvailable: () => true, desktopCodexRuntime: () => ({ codexPath: '/fixture/codex', cwd: '/fixture/work', env: {} }) }))
vi.mock('../agents/process-env.js', () => ({ agentProcessEnv: () => ({ cwd: '/fixture/work', env: {} }) }))
vi.mock('./claude-plan/runtime.js', async original => ({ ...await original<typeof import('./claude-plan/runtime.js')>(), desktopClaudeAvailable: () => true, desktopClaudeRuntime: () => ({ settings: { cwd: '/fixture/claude', env: {} }, close: async () => {} }) }))
vi.mock('ai-sdk-provider-codex-cli', async original => {
    const actual = await original<typeof import('ai-sdk-provider-codex-cli')>()
    return { ...actual, createCodexAppServer: (options: { defaultSettings: Record<string, any> }) => {
        captured.settings.push(options.defaultSettings)
        return Object.assign((modelId: string) => ({ specificationVersion: 'v3', provider: 'codex', modelId, supportedUrls: {}, doGenerate: captured.generate, doStream: captured.stream }), { close: async () => {} })
    } }
})
vi.mock('ai-sdk-provider-claude-code', async original => {
    const actual = await original<typeof import('ai-sdk-provider-claude-code')>()
    return { ...actual, createClaudeCode: (options: { defaultSettings: Record<string, any> }) => {
        captured.claude.push(options.defaultSettings)
        return { languageModel: (modelId: string) => ({ specificationVersion: 'v3', provider: 'claude', modelId, supportedUrls: {}, doGenerate: captured.generate, doStream: captured.stream }) }
    } }
})
import { buildTools } from '../tools/registry.js'
import { resolveModel } from '../agents/providers.js'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); captured.settings.length = 0; captured.claude.length = 0; captured.generate.mockClear(); captured.stream.mockClear() })
const catalogId = '00000000-0000-4000-8000-000000000001', capabilityId = '00000000-0000-4000-8000-000000000002'
function setup(name = 'public_add', provider: 'codex' | 'claude' = 'codex') {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const config = agentConfigSchema.parse({ name: 'MCP coworker', provider, model: 'fixture', tools: { desktopToolGrants: { mcp: true, workspaceList: true } } })
    captured.config = config
    const agent = {
        id: 'engine-owner', config, soul: '', install: '', env: {},
        resolved: { provider, model: 'fixture', connection: { id: provider === 'codex' ? 'mac-chatgpt' : 'mac-claude', config: connectionConfigSchema.parse({ name: provider === 'codex' ? 'ChatGPT' : 'Claude', provider, createdAt: '2026-11-04T00:00:00.000Z' }), env: provider === 'codex' ? { RERUN_CHATGPT_CONNECTED: '1' } : { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only-token' } } },
    } as LoadedAgent
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        return Response.json(body.action === 'catalog' ? { catalogId, tools: [{ capabilityId, name, description: 'Public addition', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }] } : { released: true })
    })
    vi.stubGlobal('fetch', fetcher)
    const ctx = { agent, sessionId: 'session', runId: 'run', abortSignal: new AbortController().signal, logger: { warn: vi.fn() } } as unknown as RunContext
    return { agent, ctx, fetcher }
}

function admittedNames(provider: 'codex' | 'claude'): string[] {
    return provider === 'codex'
        ? (captured.settings.at(-1)!.mcpServers?.rerun?.tools ?? []).map((entry: { name: string }) => entry.name)
        : (captured.claude.at(-1)!.allowedTools ?? []).map((name: string) => name.replace(/^mcp__rerun__/, ''))
}

test.each(['codex', 'claude'] as const)('registry-built MCP sign-in reaches the actual %s filter only while its grant remains enabled', async provider => {
    const { agent, ctx, fetcher } = setup('public_add', provider)
    const built = await buildTools(ctx)
    try {
        expect(built.tools.request_mcp_sign_in).toBeDefined()
        const granted = resolveModel(agent, undefined, built.tools)
        expect(admittedNames(provider)).toContain('request_mcp_sign_in')
        if (provider === 'codex') expect(captured.settings.at(-1)!.configOverrides['mcp_servers.rerun.enabled_tools']).toContain('request_mcp_sign_in')
        await granted.close()
        agent.config.tools.desktopToolGrants = { workspaceList: true, mcp: false }
        const revoked = resolveModel(agent, undefined, built.tools)
        expect(admittedNames(provider)).not.toContain('request_mcp_sign_in')
        await revoked.close()
    } finally { await built.close() }
    // Construction/admission can read the mocked catalog and release it, but never starts
    // OAuth, invokes a remote MCP action or asks either mocked model for a response.
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init.body)).action)).toEqual(['catalog', 'release'])
    expect(captured.generate).not.toHaveBeenCalled()
    expect(captured.stream).not.toHaveBeenCalled()
})

test.each(['missing', 'off'] as const)('the %s MCP grant keeps sign-in absent from the registry and Codex bridge', async state => {
    const { agent, ctx, fetcher } = setup()
    agent.config.tools.desktopToolGrants = state === 'missing' ? { workspaceList: true } : { workspaceList: true, mcp: false }
    const built = await buildTools(ctx)
    try {
        expect(built.tools.request_mcp_sign_in).toBeUndefined()
        const resolved = resolveModel(agent, undefined, built.tools)
        expect(admittedNames('codex')).not.toContain('request_mcp_sign_in')
        await resolved.close()
    } finally { await built.close() }
    expect(fetcher).not.toHaveBeenCalled()
    expect(captured.generate).not.toHaveBeenCalled()
    expect(captured.stream).not.toHaveBeenCalled()
})

test('MCP sign-in is not built without a live run or for a Foreman/ephemeral tool scope', async () => {
    const { agent, ctx, fetcher } = setup()
    await expect(buildTools({ ...ctx, runId: undefined })).rejects.toThrow('MCP requires an active, cancellable run')
    agent.config.kind = 'foreman'
    const foreman = await buildTools(ctx)
    try { expect(foreman.tools.request_mcp_sign_in).toBeUndefined() }
    finally { await foreman.close() }
    agent.config.kind = 'user'
    agent.config.ephemeral = true
    await expect(buildTools(ctx)).rejects.toThrow('Unowned ephemeral tool scope')
    expect(fetcher).not.toHaveBeenCalled()
    expect(captured.generate).not.toHaveBeenCalled()
    expect(captured.stream).not.toHaveBeenCalled()
})

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

test('separately granted local stdio tools reach Codex without admitting copied adapters', async () => {
    const { ctx, agent } = setup('local_echo')
    agent.config.tools.desktopToolGrants = { localMcpStdio: true, workspaceList: true }
    const built = await buildTools(ctx)
    try {
        const resolved = resolveModel(agent, undefined, { ...built.tools, local_copy: { ...built.tools.local_echo } })
        const names = captured.settings.at(-1)!.mcpServers.rerun.tools.map((entry: { name: string }) => entry.name)
        expect(names).toContain('local_echo')
        expect(names).not.toContain('local_copy')
        await resolved.close()
        agent.config.tools.desktopToolGrants = { workspaceList: true, localMcpStdio: false }
        const denied = resolveModel(agent, undefined, built.tools)
        expect(captured.settings.at(-1)!.mcpServers.rerun.tools.map((entry: { name: string }) => entry.name)).not.toContain('local_echo')
        await denied.close()
    } finally { await built.close() }
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
