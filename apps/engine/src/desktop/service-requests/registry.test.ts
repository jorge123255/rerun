// Authored only. Root runs checks and native acceptance.
import { afterEach, expect, it, vi } from 'vitest'
import { agentConfigSchema, desktopRerunGrantsOf, desktopRerunToolCatalog, type AgentConfig } from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import type { LoadedAgent } from '../../agents/types.js'
import { HITL_ACK } from '../../tools/builtin/hitl.js'

const current = vi.hoisted(() => ({ config: null as AgentConfig | null }))
vi.mock('../../agents/loader.js', async original => ({
    ...await original<typeof import('../../agents/loader.js')>(),
    readAgentConfig: async () => current.config,
}))

import { buildTools } from '../../tools/registry.js'
import { buildSystemPrompt, systemPromptText } from '../../agents/systemPrompt.js'

function agent(granted: boolean, hosted = false): LoadedAgent {
    return {
        id: 'suggestion-owner', soul: 'Help with reports.', install: '', env: {},
        config: agentConfigSchema.parse({ name: 'App helper', selfImprovement: { enabled: false }, tools: {
            memory: false, db: false, sharedDb: false, brain: false, skills: false, schedule: false, trigger: false,
            hub: false, paidData: false, computer: false, browser: false, web: false,
            askUser: false, requestApproval: false, requestSecret: false, suggestService: hosted,
            desktopToolGrants: { suggestService: granted, services: false },
        } }),
        resolved: { connection: null, provider: 'codex', model: 'fixture' },
    }
}

afterEach(() => { current.config = null; vi.unstubAllEnvs() })

it('registers only the separately granted suggestion tool and rechecks revocation before acknowledgment', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    expect(desktopRerunGrantsOf({}).suggestService).toBe(false)
    expect(desktopRerunToolCatalog.find(row => row.id === 'suggestService')).toMatchObject({ available: true, tools: ['suggest_service'] })
    const owner = agent(true)
    current.config = owner.config
    const context = { agent: owner, sessionId: 'session', runId: 'run', provider: 'codex', model: 'fixture', turnOrder: 'call-first', abortSignal: new AbortController().signal } as RunContext
    const built = await buildTools(context)
    try {
        expect(Object.keys(built.tools)).toEqual(['suggest_service'])
        expect(desktopRerunGrantsOf(owner.config.tools).services).toBe(false)
        const options = { messages: [], toolCallId: 'suggestion-call' }
        expect(await built.tools.suggest_service!.execute!({ services: [{ slug: 'notion', reason: null }] }, options)).toEqual(HITL_ACK)
        current.config = agent(false, true).config
        await expect(built.tools.suggest_service!.execute!({ services: [{ slug: 'notion' }] }, options)).rejects.toThrow('turned off')
    } finally { await built.close() }
    const disabled = await buildTools({ ...context, agent: agent(false, true) })
    try { expect(disabled.tools.suggest_service).toBeUndefined() } finally { await disabled.close() }
})

it('desktop prompt and turn order follow the suggestion grant instead of the hosted switch', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    const enabled = systemPromptText(await buildSystemPrompt(agent(true, false), { source: 'chat' }, 'codex', 'call-first'))
    expect(enabled).toContain('one to twenty unique exact catalog slugs')
    expect(enabled).toContain('using connected apps needs the separate Apps permission')
    expect(enabled).toContain('at most one card that asks the user something (suggest_service)')
    expect(enabled).not.toContain('rerun_hub_service_install')
    const disabled = systemPromptText(await buildSystemPrompt(agent(false, true), { source: 'chat' }, 'codex', 'call-first'))
    expect(disabled).not.toContain('<asking_the_user>')
    expect(disabled).not.toContain('<turn_order>')
    expect(disabled).not.toContain('one to twenty unique exact catalog slugs')
})
