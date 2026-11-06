import { afterEach, expect, it, vi } from 'vitest'
import { agentConfigSchema, desktopRerunGrantsOf, type AgentConfig } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import type { LoadedAgent } from '../../agents/types.js'
const state = vi.hoisted(() => ({ config: null as AgentConfig | null }))
vi.mock('../../agents/loader.js', async original => ({ ...await original<typeof import('../../agents/loader.js')>(), readAgentConfig: async () => state.config }))
import { buildTools } from '../../tools/registry.js'
import { buildSystemPrompt, systemPromptText } from '../../agents/systemPrompt.js'
const agent = (grant: boolean, hosted = false): LoadedAgent => ({ id: 'secret-owner', soul: 'Help with reports.', install: '', env: {},
    config: agentConfigSchema.parse({ name: 'Credential helper', selfImprovement: { enabled: false }, tools: { memory: false, db: false, sharedDb: false, brain: false, skills: false, schedule: false, trigger: false, hub: false, paidData: false, computer: false, browser: false, web: false, askUser: false, requestApproval: false, requestSecret: hosted, suggestService: false, desktopToolGrants: { requestSecret: grant } } }),
    resolved: { connection: null, provider: 'codex', model: 'fixture' },
})
afterEach(() => { state.config = null; vi.unstubAllEnvs() })
it('offers request_secret only under its default-off desktop grant and rechecks revoke/Stop', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    expect(desktopRerunGrantsOf({}).requestSecret).toBe(false)
    const owner = agent(true); state.config = owner.config
    const stop = new AbortController()
    const ctx = { agent: owner, sessionId: 'session', runId: 'run', provider: 'codex', model: 'fixture', abortSignal: stop.signal } as RunContext
    const built = await buildTools(ctx)
    try {
        expect(Object.keys(built.tools)).toEqual(['request_secret'])
        const invoke = () => built.tools.request_secret!.execute!({ secrets: [{ key: 'EXAMPLE_API_KEY', label: 'Example key' }] }, { toolCallId: 'call', messages: [] })
        expect(await invoke()).toMatchObject({ status: 'delivered' })
        state.config = agent(false, true).config
        await expect(invoke()).rejects.toThrow('turned off')
        state.config = owner.config; stop.abort()
        await expect(invoke()).rejects.toThrow()
    } finally { await built.close() }
    const disabled = await buildTools({ ...ctx, agent: agent(false, true), abortSignal: new AbortController().signal })
    try { expect(disabled.tools.request_secret).toBeUndefined() } finally { await disabled.close() }
})
it('describes only the encrypted desktop credential flow and follows its actual turn-ending grant', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const enabled = systemPromptText(await buildSystemPrompt(agent(true), { source: 'chat' }, 'codex', 'call-first'))
    expect(enabled).toContain('at most one card that asks the user something (request_secret)')
    expect(enabled).toContain('Storage alone does not grant credential use')
    const disabled = systemPromptText(await buildSystemPrompt(agent(false, true), { source: 'chat' }, 'codex', 'call-first'))
    expect(disabled).not.toContain('<asking_the_user>')
    expect(disabled).not.toContain('<turn_order>')
})
