import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText, tool } from 'ai'
import { z } from 'zod'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_OLLAMA, desktopOllamaConfig, desktopOllamaKind, desktopOllamaPolicy, resolveDesktopPreset, type BoxDefaultModel, type CustomProviderChange, type CustomProviderModel, type DesktopOllamaKind } from '@rerun/contracts'
import { agentConfigSchema } from '../../agents/types.js'
import { resolveModel } from '../../agents/providers.js'
import { findConnection, listConnections } from '../../connections/registry.js'
import { toSummary } from '../../connections/loader.js'
import { connectionRoutes } from '../../http/routes/connections.js'
import { assertDesktopProvider } from '../policy.js'
import { bindDesktopCustomProviders } from './binding.js'
import { customModelCatalog, parseOllamaTags } from './catalog.js'
import { probeCustomDraft } from './draft-probe.js'
import { DESKTOP_CUSTOM_CONNECTIONS_SCHEMA_SQL } from './store.js'

// No request leaves the test: the pinned transport is replaced, and the real Ollama on this Mac is never asked.
const state = vi.hoisted(() => ({ db: null as Client | null, defaultModel: null as BoxDefaultModel | null, request: vi.fn() }))
vi.mock('../../db/client.js', () => ({ raw: () => state.db }))
vi.mock('../../connections/default.js', () => ({
    readBoxDefault: async () => state.defaultModel,
    writeBoxDefault: async (pick: BoxDefaultModel | null) => { state.defaultModel = pick; return pick },
    updateBoxDefault: async (update: (current: BoxDefaultModel | null) => BoxDefaultModel) => { state.defaultModel = update(state.defaultModel); return state.defaultModel },
}))
vi.mock('./network.js', async original => ({ ...await original<typeof import('./network.js')>(), createPinnedProviderFetch: () => state.request }))

const launch = '11111111-1111-4111-8111-111111111111'
const ids: Record<DesktopOllamaKind, string> = { ollama: '33333333-3333-4333-8333-333333333333', 'ollama-cloud': '44444444-4444-4444-8444-444444444444' }
const syntheticKey = 'synthetic-only-ollama-key'
const signal = new AbortController().signal
// The shape Ollama 0.40 answers on GET /api/tags, with synthetic names.
const localTags = { models: [
    { name: 'synthetic-chat:latest', model: 'synthetic-chat:latest', size: 1, details: { family: '' }, capabilities: ['completion', 'vision', 'tools', 'thinking'] },
    { name: 'synthetic-plain:7b', model: 'synthetic-plain:7b', size: 1, details: {}, capabilities: ['completion'] },
    { name: 'synthetic-embed:latest', model: 'synthetic-embed:latest', size: 1, details: {}, capabilities: ['embedding'] },
    { name: 'synthetic-remote:cloud', model: 'synthetic-remote:cloud', remote_host: 'https://ollama.com', details: { context_length: 1048576 }, capabilities: ['completion', 'tools'] },
] }
const chatModel: CustomProviderModel = { id: 'synthetic-chat:latest', contextWindow: null, vision: true, source: 'discovered', tools: true }
const plainModel: CustomProviderModel = { id: 'synthetic-plain:7b', contextWindow: null, vision: false, source: 'discovered', tools: false }
const reply = (model: string) => Response.json({ id: 'fixture', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })

let directory: string
let binding: ReturnType<typeof bindDesktopCustomProviders>

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-ollama-'))
    state.db = createClient({ url: `file:${join(directory, 'custom.db')}` })
    state.defaultModel = null
    state.request.mockReset()
    await state.db.executeMultiple(DESKTOP_CUSTOM_CONNECTIONS_SCHEMA_SQL)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '7'.repeat(64))
    binding = bindDesktopCustomProviders(1, launch, () => false)
})
afterEach(async () => {
    binding?.close()
    state.db?.close()
    vi.unstubAllEnvs()
    if (directory) await rm(directory, { force: true, recursive: true })
})

function settings(input: unknown) {
    return binding.routes.request('/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rerun-launch-nonce': launch }, body: JSON.stringify(input) })
}
const change = (input: CustomProviderChange) => settings({ action: 'change', change: input })
const create = (kind: DesktopOllamaKind, models: CustomProviderModel[], apiKey?: string) => change({ action: 'create', requestId: crypto.randomUUID(), workspaceId: 1,
    connectionId: ids[kind], config: desktopOllamaConfig(kind, models), ...(apiKey && { apiKey }) })
async function agentOn(kind: DesktopOllamaKind, model: string) {
    const connection = await findConnection(ids[kind])
    return { id: 'fixture-agent', config: agentConfigSchema.parse({ name: 'Fixture', connectionId: ids[kind], provider: 'custom', model }),
        resolved: { connection, provider: 'custom' as const, model }, soul: '', install: '', env: {} }
}
const sent = (index: number) => {
    const [url, init] = state.request.mock.calls[index]!
    return { url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(init.body) : null }
}

test('reads the local model list from Ollama itself and says what each model can do', async () => {
    expect(customModelCatalog(DESKTOP_OLLAMA.ollama.baseUrl).url).toBe('http://127.0.0.1:11434/api/tags')
    expect(customModelCatalog(DESKTOP_OLLAMA['ollama-cloud'].baseUrl).url).toBe('https://ollama.com/api/tags')
    // Another address on the same port is an ordinary custom endpoint and keeps the OpenAI list.
    expect(customModelCatalog('http://localhost:11434/v1').url).toBe('http://localhost:11434/v1/models')
    expect(parseOllamaTags(localTags)).toEqual([chatModel, plainModel,
        { id: 'synthetic-remote:cloud', contextWindow: 1048576, vision: false, source: 'discovered', tools: true }])
    // An Ollama that reports no capabilities leaves tool support unknown instead of guessing.
    expect(parseOllamaTags({ models: [{ name: 'synthetic-old:latest' }] })).toEqual([{ id: 'synthetic-old:latest', contextWindow: null, vision: false, source: 'discovered' }])
    expect(() => parseOllamaTags({ data: [] })).toThrow()

    state.request.mockResolvedValueOnce(Response.json(localTags))
    const draft = await probeCustomDraft({ action: 'probe_draft', requestId: crypto.randomUUID(), workspaceId: 1,
        baseUrl: DESKTOP_OLLAMA.ollama.baseUrl, policy: desktopOllamaPolicy('ollama') }, async () => {}, signal)
    expect(draft).toMatchObject({ status: 'fresh', problem: null })
    expect(draft.models.map(model => model.id)).toEqual(['synthetic-chat:latest', 'synthetic-plain:7b', 'synthetic-remote:cloud'])
    expect(sent(0).url).toBe('http://127.0.0.1:11434/api/tags')
    expect(sent(0).headers.has('authorization')).toBe(false)
})

test('Ollama not running is reported as unreachable and never as an empty list', async () => {
    state.request.mockRejectedValueOnce(new Error('Custom endpoint unavailable or cancelled.'))
    const draft = await probeCustomDraft({ action: 'probe_draft', requestId: crypto.randomUUID(), workspaceId: 1,
        baseUrl: DESKTOP_OLLAMA.ollama.baseUrl, policy: desktopOllamaPolicy('ollama') }, async () => {}, signal)
    expect(draft).toMatchObject({ status: 'unavailable', problem: 'unreachable', models: [] })

    // A saved connection keeps its models while Ollama is closed.
    const receipt = await (await create('ollama', [chatModel])).json()
    state.request.mockRejectedValueOnce(new Error('Custom endpoint unavailable or cancelled.'))
    expect(await (await settings({ action: 'probe', identity: receipt.identity })).json()).toMatchObject({ status: 'unavailable', problem: 'unreachable' })
    const saved = toSummary((await findConnection(ids.ollama))!)
    expect(saved).toMatchObject({ connected: true, models: ['synthetic-chat:latest'] })
})

test('a local Ollama model is a runnable connection: workspace default, tools, no key', async () => {
    expect((await create('ollama', [chatModel, plainModel])).status).toBe(200)
    const summary = toSummary((await listConnections()).find(item => item.id === ids.ollama)!)
    expect(summary).toMatchObject({ provider: 'custom', name: 'Ollama (this Mac)', baseUrl: 'http://127.0.0.1:11434/v1', connected: true, customRevision: 1 })
    expect(desktopOllamaKind(summary)).toBe('ollama')
    // The Mac policy admits it as a registered connection, and only as one.
    expect(() => assertDesktopProvider('custom', ids.ollama)).not.toThrow()
    expect(() => assertDesktopProvider('custom', 'ollama')).toThrow('unavailable')
    const chosen = await connectionRoutes.request('/default', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: ids.ollama, model: chatModel.id }) })
    expect(chosen.status).toBe(200)
    expect(state.defaultModel).toEqual({ connectionId: ids.ollama, model: chatModel.id })
    // Rerun Fast, Balanced and Smart never land on Ollama by themselves.
    for (const tier of ['fast', 'balanced', 'smart'] as const) expect(resolveDesktopPreset(tier, [summary])).toBeNull()

    const tools = { lookup: tool({ description: 'Synthetic lookup', inputSchema: z.object({ query: z.string() }), execute: async () => 'found' }) }
    state.request.mockImplementation(async () => reply(chatModel.id))
    const resolved = resolveModel(await agentOn('ollama', chatModel.id))
    try { expect((await generateText({ model: resolved.model, prompt: 'Fixture only', tools, maxRetries: 0 })).text).toBe('synthetic reply') }
    finally { await resolved.close() }
    expect(sent(0).url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(sent(0).headers.has('authorization')).toBe(false)
    expect(sent(0).body).toMatchObject({ model: chatModel.id, tools: [{ type: 'function', function: { name: 'lookup' } }] })

    // Ollama said this model cannot call tools: the turn stops with that reason before any request.
    const plain = resolveModel(await agentOn('ollama', plainModel.id))
    try {
        await expect(generateText({ model: plain.model, prompt: 'Fixture only', tools, maxRetries: 0 })).rejects.toThrow('cannot call tools in Ollama')
        expect(state.request).toHaveBeenCalledTimes(1)
        expect((await generateText({ model: plain.model, prompt: 'No tools here', maxRetries: 0 })).text).toBe('synthetic reply')
    } finally { await plain.close() }
    const agent = await agentOn('ollama', chatModel.id)
    expect(() => resolveModel(agent, { model: 'not-pulled' })).toThrow('offered')
})

test('the Ollama Cloud key is stored encrypted, sent only to ollama.com, and gone when removed', async () => {
    const cloudModel: CustomProviderModel = { id: 'synthetic-hosted:31b', contextWindow: null, vision: false, source: 'discovered', tools: true }
    const response = await create('ollama-cloud', [cloudModel], syntheticKey)
    expect(response.status).toBe(200)
    const receipt = await response.json()
    const stored = await state.db!.execute('SELECT ciphertext,snapshot FROM desktop_custom_connections')
    expect(stored.rows[0]?.ciphertext).toBeTruthy()
    expect(JSON.stringify(stored.rows)).not.toContain(syntheticKey)
    expect(JSON.stringify((await state.db!.execute('SELECT * FROM desktop_custom_connection_receipts')).rows)).not.toContain(syntheticKey)
    // Settings can read the connection back, never the key.
    expect(await (await settings({ action: 'read', identity: receipt.identity })).text()).not.toContain(syntheticKey)
    const summary = toSummary((await findConnection(ids['ollama-cloud']))!)
    expect(JSON.stringify(summary)).not.toContain(syntheticKey)
    expect(summary).toMatchObject({ name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', connected: true })
    expect(desktopOllamaKind(summary)).toBe('ollama-cloud')

    state.request.mockResolvedValueOnce(Response.json({ models: [{ name: cloudModel.id, capabilities: ['completion', 'tools'] }, { name: 'synthetic-judge:27b', capabilities: ['completion', 'decision'] }] }))
    const probe = await (await settings({ action: 'probe', identity: receipt.identity })).json()
    expect(probe).toMatchObject({ status: 'fresh', problem: null, models: [{ id: cloudModel.id, tools: true }, { id: 'synthetic-judge:27b', tools: false }] })
    expect(sent(0).url).toBe('https://ollama.com/api/tags')
    expect(sent(0).headers.get('authorization')).toBe(`Bearer ${syntheticKey}`)

    state.request.mockImplementation(async () => reply(cloudModel.id))
    const resolved = resolveModel(await agentOn('ollama-cloud', cloudModel.id))
    try { expect((await generateText({ model: resolved.model, prompt: 'Fixture only', maxRetries: 0 })).text).toBe('synthetic reply') }
    finally { await resolved.close() }
    expect(sent(1).url).toBe('https://ollama.com/v1/chat/completions')
    expect(sent(1).headers.get('authorization')).toBe(`Bearer ${syntheticKey}`)
    expect(state.request.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://ollama.com')).toBe(true)

    // Replacing the key bumps the revision; the old one is no longer usable.
    const replaced = await (await change({ action: 'update', requestId: crypto.randomUUID(), identity: receipt.identity, config: desktopOllamaConfig('ollama-cloud', [cloudModel]), apiKey: 'synthetic-replacement-key', clearSecret: false })).json()
    expect(replaced.identity.revision).toBe(2)
    expect((await settings({ action: 'read', identity: receipt.identity })).status).toBe(409)

    // The workspace default cannot be pulled out from under the owner.
    state.defaultModel = { connectionId: ids['ollama-cloud'], model: cloudModel.id }
    expect((await change({ action: 'disconnect', requestId: crypto.randomUUID(), identity: replaced.identity })).status).toBe(409)
    state.defaultModel = null
    expect((await change({ action: 'disconnect', requestId: crypto.randomUUID(), identity: replaced.identity })).status).toBe(200)
    expect((await state.db!.execute('SELECT ciphertext FROM desktop_custom_connections')).rows[0]?.ciphertext).toBeNull()
    expect((await listConnections()).some(item => item.id === ids['ollama-cloud'])).toBe(false)
    const gone = await agentOn('ollama-cloud', cloudModel.id)
    expect(() => resolveModel(gone)).toThrow()
})
