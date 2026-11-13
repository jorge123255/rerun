import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Provider } from '@rerun/contracts'
import type { LoadedAgent } from '../agents/types.js'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-plan-'))

const { afterEach, describe, expect, it, vi } = await import('vitest')
const { readFile, rm, writeFile } = await import('node:fs/promises')
const { DEFAULT_CONNECTION_MODELS, agentConfigSchema } = await import('@rerun/contracts')
const { boxPlanPath, connectionsDir } = await import('../config/paths.js')
const { createConnection } = await import('./store.js')
const { allowedModel, readBoxPlan, writeBoxPlan } = await import('./plan.js')
const { defaultModelOf, resolveConfiguredModel, resolveRunModel } = await import('../agents/availability.js')

async function pinnedAgent(provider: Provider, model: string, models = DEFAULT_CONNECTION_MODELS[provider]): Promise<LoadedAgent> {
    const connection = await createConnection({ name: provider, provider, models, extraModels: [], keys: {} })
    const config = agentConfigSchema.parse({ name: 'a1', connectionId: connection.id, provider, model })
    return { id: 'a1', config, soul: '', install: '', env: {}, resolved: await resolveConfiguredModel(config) }
}

afterEach(async () => {
    vi.unstubAllEnvs()
    await writeBoxPlan({ premiumModels: true })
    await rm(connectionsDir(), { recursive: true, force: true })
})

describe('box plan storage', () => {
    it('runs everything on a box the hub never told', async () => {
        await rm(boxPlanPath(), { force: true })
        expect(readBoxPlan()).toEqual({ premiumModels: true })
    })

    it('round trips through the file', async () => {
        await writeBoxPlan({ premiumModels: false })
        expect(JSON.parse(await readFile(boxPlanPath(), 'utf8'))).toEqual({ premiumModels: false })
        expect(readBoxPlan()).toEqual({ premiumModels: false })
    })
})

describe('allowedModel', () => {
    it('leaves every model alone on a paid plan', () => {
        expect(allowedModel('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5')
        expect(allowedModel('codex', 'gpt-6-astra')).toBe('gpt-6-astra')
    })

    it('steps a trial down to Sonnet and Sol, in the spelling of each provider', async () => {
        await writeBoxPlan({ premiumModels: false })
        expect(allowedModel('claude', 'claude-opus-5-5')).toBe('claude-sonnet-5-5')
        expect(allowedModel('claude', 'opus')).toBe('claude-sonnet-5-5')
        expect(allowedModel('anthropic', 'claude-fable-5-1')).toBe('claude-sonnet-5-5')
        expect(allowedModel('openrouter', 'anthropic/claude-opus-5.5')).toBe('anthropic/claude-sonnet-5.5')
        expect(allowedModel('openrouter', 'openai/gpt-6-astra')).toBe('openai/gpt-6-sol')
        expect(allowedModel('codex', 'gpt-6-astra')).toBe('gpt-6-sol')
        expect(allowedModel('codex', 'gpt-6-sol')).toBe('gpt-6-sol')
        expect(allowedModel('claude', 'claude-sonnet-5[1m]')).toBe('claude-sonnet-5[1m]')
    })
})

describe('model resolution on a trial box', () => {
    it('runs a pinned Opus agent on Sonnet without rewriting the pin', async () => {
        await writeBoxPlan({ premiumModels: false })
        const agent = await pinnedAgent('claude', 'claude-opus-5-5')
        expect(agent.resolved.model).toBe('claude-sonnet-5-5')
        expect(agent.config.model).toBe('claude-opus-5-5')
    })

    it('steps down a premium model asked for by a single run', async () => {
        await writeBoxPlan({ premiumModels: false })
        const agent = await pinnedAgent('codex', 'gpt-6-sol')
        expect((await resolveRunModel(agent, { model: 'gpt-6-astra' })).model).toBe('gpt-6-sol')
    })

    // The hub names a connection and a model in a chat, never a provider: the substitute has to be
    // spelled for the connection the override picked, not for the one the agent runs on.
    it('steps a run down in the spelling of the connection the override names', async () => {
        await writeBoxPlan({ premiumModels: false })
        const agent = await pinnedAgent('codex', 'gpt-6-sol')
        const claude = await createConnection({ name: 'claude', provider: 'claude', models: DEFAULT_CONNECTION_MODELS.claude, extraModels: [], keys: {} })
        const run = await resolveRunModel(agent, { connectionId: claude.id, model: 'claude-opus-5-5' })
        expect(run).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' })
    })

    it('adopts the first model the plan runs as the connection default', async () => {
        const connection = await createConnection({ name: 'claude', provider: 'claude', models: DEFAULT_CONNECTION_MODELS.claude, extraModels: [], keys: {} })
        expect(defaultModelOf(connection)).toBe('claude-opus-5-5')
        await writeBoxPlan({ premiumModels: false })
        expect(defaultModelOf(connection)).toBe('claude-sonnet-5-5')
    })

    it('reads a corrupt file as unrestricted', async () => {
        await writeBoxPlan({ premiumModels: false })
        await writeFile(boxPlanPath(), '{ not json', 'utf8')
        vi.resetModules()
        const fresh = await import('./plan.js')
        expect(fresh.readBoxPlan()).toEqual({ premiumModels: true })
    })
})

it('keeps local Mac model selections even with a legacy trial plan on disk', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '0'.repeat(64))
    await writeBoxPlan({ premiumModels: false })
    const model = 'anthropic/claude-opus-5.5'
    const agent = await pinnedAgent('openrouter', model, [model, 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra'])

    expect(agent.resolved.model).toBe(model)
    expect(defaultModelOf(agent.resolved.connection!)).toBe(model)
    expect(await resolveRunModel(agent, { model: 'openai/gpt-6-astra' })).toMatchObject({
        provider: 'openrouter',
        model: 'openai/gpt-6-astra',
    })
    expect(readBoxPlan()).toEqual({ premiumModels: false })
})
