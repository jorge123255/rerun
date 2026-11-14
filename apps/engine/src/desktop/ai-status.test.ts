import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentConfigSchema, desktopRerunGrantsOf, DESKTOP_OPENCODE_CONNECTION_ID, type AgentConfig } from '@rerun/contracts'
import type { LoadedConnection } from '../connections/types.js'
import type { RunContext } from '../runtime/context.js'

const fixture = vi.hoisted(() => ({
    config: null as AgentConfig | null,
    connections: [] as LoadedConnection[],
    list: vi.fn(async () => fixture.connections),
}))
vi.mock('../agents/loader.js', async original => ({
    ...await original<typeof import('../agents/loader.js')>(),
    readAgentConfig: async () => fixture.config,
}))
vi.mock('../connections/registry.js', async original => ({
    ...await original<typeof import('../connections/registry.js')>(),
    listConnections: fixture.list,
}))
vi.mock('../connections/default.js', () => ({
    readBoxDefault: async () => ({ connectionId: DESKTOP_OPENCODE_CONNECTION_ID, model: 'go/deepseek-v4-pro' }),
}))
vi.mock('./opencode/registry.js', async original => ({
    ...await original<typeof import('./opencode/registry.js')>(),
    desktopOpencodeCredential: async () => 'synthetic-opencode-secret',
}))

import { buildTools } from '../tools/registry.js'
import { desktopAiStatusTools } from './ai-status.js'
import { registerDelegationChild } from './delegation/child-scope.js'
import { resetDesktopOpencodeLimitsForTests } from './opencode/limits.js'
import { forgetCredentialRejected, recordCredentialRejected } from '../connections/credential-rejections.js'

const model = 'go/deepseek-v4-pro'
const opencode = (revision = 'revision-a'): LoadedConnection => ({
    id: DESKTOP_OPENCODE_CONNECTION_ID,
    config: { provider: 'opencode', name: 'Workspace OpenCode', models: [model], extraModels: [], createdAt: '' },
    env: {},
    opencode: { workspaceId: 1, connectionId: DESKTOP_OPENCODE_CONNECTION_ID, revision, name: 'Workspace OpenCode',
        defaultModelId: model, enabledModelIds: [model], consoleEnabled: false },
})
const api: LoadedConnection = {
    id: 'api-fixture', config: { provider: 'openai', name: 'Workspace API key', models: ['gpt-test'], extraModels: ['gpt-test'], createdAt: '' },
    env: { OPENAI_API_KEY: 'synthetic-openai-secret' },
}
const hosted: LoadedConnection = { ...api, id: 'rerun', config: { ...api.config, provider: 'rerun', name: 'Hosted-only entry' } }
const response = () => Response.json({ usage: {
    rolling: { status: 'ok', percent: 31, resetsAt: '2099-01-01T00:00:00.000Z' },
    weekly: { status: 'limited', percent: 81, resetsAt: '2099-01-02T00:00:00.000Z' },
} })
const options = { toolCallId: 'status-1', messages: [] }

function config(granted: boolean, extra: Record<string, unknown> = {}) {
    return agentConfigSchema.parse({ name: 'AI status fixture', tools: { desktopToolGrants: { aiProviders: granted } }, ...extra })
}
function context(cfg: AgentConfig, signal?: AbortSignal) {
    return { agent: { id: 'status-fixture', config: cfg, env: {}, soul: '', install: '',
        resolved: { provider: 'opencode', model, connection: opencode() } },
        runId: 'run-1', sessionId: 'session-1', provider: 'opencode', model, turnOrder: 'message-first', abortSignal: signal,
    } as RunContext
}

beforeEach(() => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    fixture.config = config(true)
    fixture.connections = [api, opencode(), hosted]
    fixture.list.mockClear()
    resetDesktopOpencodeLimitsForTests()
})
afterEach(() => {
    forgetCredentialRejected(api.id)
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

it('registers the built-in only with an explicit coworker grant and refuses an ephemeral copy', async () => {
    expect(desktopRerunGrantsOf({}).aiProviders).toBe(false)
    for (const cfg of [config(false), config(true)]) {
        const built = await buildTools(context(cfg))
        try {
            expect(!!built.tools.ai_status).toBe(cfg.tools.desktopToolGrants?.aiProviders === true)
        } finally { await built.close() }
    }
    const child = context(config(true, { ephemeral: true }))
    const scope = registerDelegationChild({ agent: child.agent, sessionId: child.sessionId, runId: child.runId!,
        signal: new AbortController().signal, tools: [], authorize: async () => {} })
    try {
        const built = await buildTools(child)
        try { expect(built.tools.ai_status).toBeUndefined() } finally { await built.close() }
    } finally { scope.close() }
    expect(desktopAiStatusTools(context(config(true, { kind: 'foreman' })))).toEqual({})
    expect(fixture.list).not.toHaveBeenCalled()
})

it('reports the exact selected model, saved default, usable providers and bounded quota without secret fields', async () => {
    const fetcher = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetcher)
    const execute = desktopAiStatusTools(context(config(true))).ai_status!.execute!
    const result = await execute({}, options)
    expect(result).toMatchObject({
        current: { connectionId: DESKTOP_OPENCODE_CONNECTION_ID, connectionName: 'Workspace OpenCode', model },
        workspaceDefault: { connectionId: DESKTOP_OPENCODE_CONNECTION_ID, model },
        connections: [
            { id: api.id, connected: true, credentialRejected: false, models: ['gpt-test'], planLimits: null, limitReached: null },
            { id: DESKTOP_OPENCODE_CONNECTION_ID, connected: true, models: [model], limitReached: true,
                planLimits: { scope: 'OpenCode Go', readAt: expect.any(String),
                    windows: [{ kind: 'session', usedPercent: 31 }, { kind: 'weekly', usedPercent: 100 }] } },
        ],
        rerunCredit: null,
    })
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(opencode|openai)-secret|Hosted-only entry/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    recordCredentialRejected(api.id)
    expect(await execute({}, options)).toMatchObject({ connections: [
        { id: api.id, credentialRejected: true, models: [], planLimits: null },
        { id: DESKTOP_OPENCODE_CONNECTION_ID },
    ] })
    expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps a failed or missing quota unknown without losing the model or connected state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const tool = desktopAiStatusTools(context(config(true))).ai_status!
    expect(await tool.execute!({}, options)).toMatchObject({
        current: { model }, connections: [{ id: api.id }, { connected: true, planLimits: null, limitReached: null }],
    })
})

it.each(['revocation', 'replacement', 'stop'] as const)('rechecks %s during the quota read', async mode => {
    let markStarted!: () => void
    let reply!: (value: Response) => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(() => {
        markStarted()
        return new Promise<Response>(resolve => { reply = resolve })
    }))
    const stop = new AbortController()
    const tool = desktopAiStatusTools(context(config(true), stop.signal)).ai_status!
    const pending = tool.execute!({}, options)
    await started
    if (mode === 'revocation') fixture.config = config(false)
    if (mode === 'replacement') fixture.connections = [api, opencode('revision-b')]
    if (mode === 'stop') stop.abort()
    reply(response())
    if (mode === 'revocation') await expect(pending).rejects.toThrow('turned off')
    else if (mode === 'stop') await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    else await expect(pending).resolves.toMatchObject({ connections: [{ id: api.id }, { planLimits: null, limitReached: null }] })
})
