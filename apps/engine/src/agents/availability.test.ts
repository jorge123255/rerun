import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Provider } from '@rerun/contracts'
import type { LoadedAgent } from './types.js'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-availability-'))
// `env()` caches on first call, and the first call happens while the imports below run, so the hub
// credentials the keyless Rerun connection is judged on have to be in place before them.
process.env.RERUN_HUB_BASE_URL = 'https://hub.example.com'
process.env.RERUN_API_KEY = 'hub-key'

const { beforeEach, describe, expect, it, vi } = await import('vitest')
const { rm } = await import('node:fs/promises')
const { DEFAULT_CONNECTION_MODELS, RERUN_CONNECTION_ID, RERUN_MODEL, agentConfigSchema } = await import('@rerun/contracts')
const { connectionsDir } = await import('../config/paths.js')
const { createConnection, ensureRerunConnection } = await import('../connections/store.js')
const { getConnection } = await import('../connections/registry.js')
const { clearAgentCache } = await import('./registry.js')
const { clearBoxDefault, writeBoxDefault } = await import('../connections/default.js')
const { boxDefaultModel, isUsable, resolveAutomationModel, resolveConfiguredModel } = await import('./availability.js')

let seq = 0

async function connect(provider: Provider, keys: Record<string, string>, models = DEFAULT_CONNECTION_MODELS[provider]) {
    seq += 1
    return createConnection({ name: `${provider}-${seq}`, provider, models, extraModels: [], keys })
}

async function makeAgent(connectionId: string | null, provider: Provider | null, model: string | null): Promise<LoadedAgent> {
    const config = agentConfigSchema.parse({ name: 'a1', connectionId, provider, model })
    return { id: 'a1', config, soul: '', install: '', env: {}, resolved: await resolveConfiguredModel(config) }
}

// An agent that picked nothing: the state a freshly created one starts in.
function boxDefaultAgent(): Promise<LoadedAgent> {
    return makeAgent(null, null, null)
}

// Each test starts from a bare box. `ensureRerunConnection` is called explicitly rather than here,
// so a test can describe a box that has no keyless fallback at all.
beforeEach(async () => {
    await clearBoxDefault()
    await rm(connectionsDir(), { recursive: true, force: true })
    clearAgentCache()
    seq = 0
})

describe('isUsable', () => {
    it('needs both a credential and the model on the connection', async () => {
        const withKey = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        expect(isUsable(withKey, 'claude-opus-4-8')).toBe(true)
        expect(isUsable(withKey, 'gpt-4o')).toBe(false)

        const withoutKey = await connect('anthropic', {})
        expect(isUsable(withoutKey, 'claude-opus-4-8')).toBe(false)
    })

    it('accepts a model the catalog does not know but the connection advertises', async () => {
        const connection = await createConnection({ name: 'custom router', provider: 'openrouter', models: [], extraModels: ['acme/router-large'], keys: { OPENROUTER_API_KEY: 'k' } })
        expect(isUsable(connection, 'acme/router-large')).toBe(true)
    })

    it('reads the keyless Rerun connection off the hub configuration', async () => {
        await ensureRerunConnection()
        expect(isUsable(await getConnection(RERUN_CONNECTION_ID), RERUN_MODEL)).toBe(true)
    })

    it('is false for an agent with no connection at all', () => {
        expect(isUsable(null, RERUN_MODEL)).toBe(false)
    })
})

describe('resolveAutomationModel', () => {
    it('leaves an available request untouched', async () => {
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const agent = await makeAgent(anthropic.id, 'anthropic', 'claude-sonnet-4-6')
        expect(await resolveAutomationModel(agent, { connectionId: anthropic.id, model: 'claude-opus-4-8' })).toEqual({
            connectionId: anthropic.id,
            provider: 'anthropic',
            model: 'claude-opus-4-8',
        })
    })

    it('falls back to the agent default when the requested connection lost its credential', async () => {
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const claude = await connect('claude', {})
        const agent = await makeAgent(anthropic.id, 'anthropic', 'claude-opus-4-8')
        expect(await resolveAutomationModel(agent, { connectionId: claude.id, model: 'opus' })).toEqual({
            connectionId: anthropic.id,
            provider: 'anthropic',
            model: 'claude-opus-4-8',
        })
    })

    it('falls back to Rerun before any other connection', async () => {
        await ensureRerunConnection()
        await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const claude = await connect('claude', {})
        const agent = await makeAgent(claude.id, 'claude', 'opus')
        expect(await resolveAutomationModel(agent, undefined)).toEqual({ connectionId: RERUN_CONNECTION_ID, provider: 'rerun', model: RERUN_MODEL })
    })

    it('falls back to any connected connection when the box has no Rerun one', async () => {
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const claude = await connect('claude', {})
        const agent = await makeAgent(claude.id, 'claude', 'opus')
        expect(await resolveAutomationModel(agent, undefined)).toEqual({
            connectionId: anthropic.id,
            provider: 'anthropic',
            model: DEFAULT_CONNECTION_MODELS.anthropic[0],
        })
    })

    it('rejects a model the connection was curated to exclude', async () => {
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' }, ['claude-sonnet-4-6'])
        const agent = await makeAgent(anthropic.id, 'anthropic', 'claude-sonnet-4-6')
        expect(await resolveAutomationModel(agent, { connectionId: anthropic.id, model: 'claude-opus-4-8' })).toEqual({
            connectionId: anthropic.id,
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
        })
    })

    it('keeps failing as before when nothing on the box is usable', async () => {
        const claude = await connect('claude', {})
        const agent = await makeAgent(claude.id, 'claude', 'opus')
        expect(await resolveAutomationModel(agent, undefined)).toEqual({ connectionId: claude.id, provider: 'claude', model: 'opus' })
    })
})

describe('boxDefaultModel', () => {
    it('answers what the owner set', async () => {
        await ensureRerunConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        expect(await boxDefaultModel()).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
    })

    it('skips a default whose credential is gone', async () => {
        await ensureRerunConnection()
        const claude = await connect('claude', {})
        await writeBoxDefault({ connectionId: claude.id, model: 'opus' })
        expect(await boxDefaultModel()).toMatchObject({ provider: 'rerun', model: RERUN_MODEL })
    })

    it('skips a default naming a model the connection no longer offers', async () => {
        await ensureRerunConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' }, ['claude-sonnet-4-6'])
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        expect(await boxDefaultModel()).toMatchObject({ provider: 'rerun', model: RERUN_MODEL })
    })

    it('falls back to Rerun when nothing was ever set', async () => {
        await ensureRerunConnection()
        expect(await boxDefaultModel()).toMatchObject({ provider: 'rerun', model: RERUN_MODEL })
    })

    it('reads exactly like the old hardcoded defaults on a box with nothing plugged in', async () => {
        expect(await boxDefaultModel()).toEqual({ connection: null, provider: 'rerun', model: RERUN_MODEL })
    })
})

describe('resolveConfiguredModel', () => {
    it('follows the box default when the agent named no model', async () => {
        await ensureRerunConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        expect(await resolveConfiguredModel((await boxDefaultAgent()).config)).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
    })

    it('ignores a leftover connectionId sitting next to a null model', async () => {
        await ensureRerunConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        const stale = await connect('claude', { CLAUDE_CODE_OAUTH_TOKEN: 't' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        const config = agentConfigSchema.parse({ name: 'a1', connectionId: stale.id, provider: 'claude', model: null })
        expect(await resolveConfiguredModel(config)).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
    })

    it('returns a pin as asked even when its credential was pulled, rather than swapping it', async () => {
        await ensureRerunConnection()
        const claude = await connect('claude', {})
        expect(await resolveConfiguredModel((await makeAgent(claude.id, 'claude', 'opus')).config)).toMatchObject({ connection: claude, provider: 'claude', model: 'opus' })
    })

    it('still maps a bare provider onto the oldest connection of that provider', async () => {
        // Awaited file writes can still finish within one clock millisecond. A
        // tied timestamp intentionally uses ID order, which is a separate test.
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
            const first = await connect('anthropic', { ANTHROPIC_API_KEY: 'k1' })
            vi.setSystemTime(new Date('2026-01-01T00:00:00.001Z'))
            const second = await connect('anthropic', { ANTHROPIC_API_KEY: 'k2' })
            expect(Date.parse(first.config.createdAt)).toBeLessThan(Date.parse(second.config.createdAt))
            const resolved = await resolveConfiguredModel(agentConfigSchema.parse({ name: 'a1', provider: 'anthropic', model: 'claude-opus-4-8' }))
            expect(resolved.connection?.id).toBe(first.id)
        } finally { vi.useRealTimers() }
    })
})

describe('resolveAutomationModel over a box-default agent', () => {
    it('runs the box default when the automation names no model of its own', async () => {
        await ensureRerunConnection()
        const anthropic = await connect('anthropic', { ANTHROPIC_API_KEY: 'k' })
        await writeBoxDefault({ connectionId: anthropic.id, model: 'claude-opus-4-8' })
        expect(await resolveAutomationModel(await boxDefaultAgent(), undefined)).toEqual({ connectionId: anthropic.id, provider: 'anthropic', model: 'claude-opus-4-8' })
    })
})
