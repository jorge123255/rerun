import { afterEach, expect, test, vi } from 'vitest'
import { agentConfigSchema, connectionConfigSchema } from '@rerun/contracts'
import type { LoadedAgent } from '../../agents/types.js'
import type { RunContext } from '../../runtime/context.js'

const captured = vi.hoisted(() => ({ settings: [] as Record<string, unknown>[], agent: null as unknown }))
vi.mock('../../config/env.js', () => ({ env: () => ({ RERUN_HUB_BASE_URL: 'http://127.0.0.1:3123', RERUN_API_KEY: 'fixture', RERUN_DATA_DIR: '/fixture-only', RERUN_LOG_LEVEL: 'silent' }) }))
vi.mock('../../agents/registry.js', () => ({ getAgent: async () => captured.agent }))
vi.mock('../../db/repos/sessions.js', () => ({ getSession: async () => ({ id: 'session', agentId: 'foreman', source: 'dashboard', status: 'open', originAgentId: null, originSessionId: null }) }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: async () => ({ id: 'run', agentId: 'foreman', sessionId: 'session', status: 'running' }) }))
vi.mock('../codex-runtime.js', () => ({ signedInFlag: 'RERUN_CHATGPT_CONNECTED', DESKTOP_CODEX_ID: 'mac-chatgpt', desktopCodexAvailable: () => true, desktopCodexRuntime: () => ({ codexPath: '/fixture/codex', cwd: '/fixture/work', env: {} }) }))
vi.mock('ai-sdk-provider-codex-cli', async original => {
    const actual = await original<typeof import('ai-sdk-provider-codex-cli')>()
    return { ...actual, createCodexAppServer: (options: { defaultSettings: Record<string, unknown> }) => {
        captured.settings.push(options.defaultSettings)
        return Object.assign((modelId: string) => ({ specificationVersion: 'v3', provider: 'codex', modelId, supportedUrls: {}, doGenerate: vi.fn(), doStream: vi.fn() }), { close: async () => {} })
    } }
})
import { resolveModel } from '../../agents/providers.js'
import { buildTools } from '../../tools/registry.js'
import { bindDesktopForeman } from './binding.js'

let close: (() => void) | undefined
afterEach(() => { close?.(); close = undefined; captured.settings.length = 0; vi.unstubAllEnvs() })
const names = () => {
    const servers = captured.settings.at(-1)?.mcpServers as { rerun?: { tools: Array<{ name: string }> } } | undefined
    return servers?.rerun?.tools.map(tool => tool.name) ?? []
}

test('authenticated Foreman plan tools reach the real Codex filter without granting them to coworkers or copies', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const agent: LoadedAgent = {
        id: 'foreman', config: agentConfigSchema.parse({ name: 'Foreman', kind: 'foreman', provider: 'codex', model: 'fixture' }), soul: '', install: '', env: {},
        resolved: { provider: 'codex', model: 'fixture', connection: { id: 'mac-chatgpt', config: connectionConfigSchema.parse({ name: 'ChatGPT', provider: 'codex', createdAt: '2026-11-04T00:00:00.000Z' }), env: { RERUN_CHATGPT_CONNECTED: '1' } } },
    }
    captured.agent = agent
    const runtime = { launchNonce: '00000000-0000-4000-8000-000000000001', app: { origin: 'http://127.0.0.1:44000' }, engine: { apiKey: 'a'.repeat(64) } }
    const binding = { workspaceId: '1', chatId: 'fmc_chat-0001', runId: 'run', model: { connectionId: 'mac-chatgpt', model: 'fixture' } }
    close = bindDesktopForeman(runtime, vi.fn(async () => Response.json({ binding, discovery: false })) as typeof fetch).close
    const ctx = { agent, model: 'fixture', sessionId: 'session', runId: 'run', abortSignal: new AbortController().signal } as RunContext
    const built = await buildTools(ctx)
    try {
        const live = resolveModel(agent, undefined, built.tools)
        expect(names()).toEqual(['show_plan', 'open_panel'])
        expect(captured.settings.at(-1)?.env).toMatchObject({ RERUN_NATIVE_SHELL: '0', RERUN_DESKTOP_CODEX_CODE_MODE: '0', RERUN_DESKTOP_CODEX_WEB: '0' })
        await live.close()
        const copied = resolveModel(agent, undefined, { show_plan: { ...built.tools.show_plan! }, open_panel: built.tools.show_plan! })
        expect(names()).toEqual([])
        await copied.close()
        const sibling = resolveModel({ ...agent, id: 'sibling' }, undefined, built.tools)
        expect(names()).toEqual([])
        await sibling.close()
    } finally { await built.close() }
})
