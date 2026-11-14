import { createClient, type Client } from '@libsql/client'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText, streamText } from 'ai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Hono } from 'hono'
import { agentConfigSchema } from '../../agents/types.js'
import { modelFor, resolveModel } from '../../agents/providers.js'
import { findConnection, listConnections } from '../../connections/registry.js'
import { createConnection } from '../../connections/store.js'
import { isConnected, toSummary } from '../../connections/loader.js'
import { connectionRoutes } from '../../http/routes/connections.js'
import { bindDesktopCustomProviders } from './binding.js'
import { DESKTOP_CUSTOM_CONNECTIONS_SCHEMA_SQL } from './store.js'
import type { BoxDefaultModel, CustomProviderChange, CustomProviderConfig, CustomProviderSnapshot } from '@rerun/contracts'
import { desktopCustomEffort } from '../../agents/reasoning.js'
import { HttpError } from '../../lib/errors.js'

const state = vi.hoisted(() => ({ db: null as Client | null, defaultModel: null as BoxDefaultModel | null }))
vi.mock('../../db/client.js', () => ({ raw: () => state.db }))
vi.mock('../../connections/default.js', () => ({
    readBoxDefault: async () => state.defaultModel,
    writeBoxDefault: async (pick: typeof state.defaultModel) => { state.defaultModel = pick; return pick },
    updateBoxDefault: async (update: (current: BoxDefaultModel | null) => BoxDefaultModel) => {
        state.defaultModel = update(state.defaultModel)
        return state.defaultModel
    },
}))

const launch = '11111111-1111-4111-8111-111111111111'
const connectionId = '22222222-2222-4222-8222-222222222222'
const modelId = 'synthetic/model'
const fixtureKey = 'synthetic-only-custom-key'
let directory: string
let server: Server | undefined
let binding: ReturnType<typeof bindDesktopCustomProviders>
let baseUrl: string
let requests: { model: string; authorization?: string; streaming: boolean }[]
let abortSeen: Promise<void>
let holdStream = false

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-custom-custody-'))
    state.db = createClient({ url: `file:${join(directory, 'custom.db')}` })
    state.defaultModel = null
    await state.db.executeMultiple(DESKTOP_CUSTOM_CONNECTIONS_SCHEMA_SQL)
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', '7'.repeat(64))
    requests = []
    holdStream = false
    let closed!: () => void
    abortSeen = new Promise(resolve => { closed = resolve })
    server = createServer(async (req, res) => {
        if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())
        requests.push({ model: body.model, authorization: req.headers.authorization, streaming: !!body.stream })
        if (!body.stream) {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
                id: 'fixture', object: 'chat.completion', created: 1, model: body.model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic reply' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            }))
            return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (content: string, reason: string | null) => JSON.stringify({
            id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
            choices: [{ index: 0, delta: { content }, finish_reason: reason }],
        })
        res.write(`data: ${chunk('synthetic stream', null)}\n\n`)
        if (holdStream) res.once('close', closed)
        else res.end(`data: ${chunk('', 'stop')}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject).listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    baseUrl = `http://127.0.0.1:${address.port}/v1`
    binding = bindDesktopCustomProviders(1, launch, () => false)
})

afterEach(async () => {
    binding?.close()
    if (server) {
        server.closeAllConnections()
        await new Promise<void>(resolve => { server!.close(() => resolve()) })
        server = undefined
    }
    state.db?.close()
    vi.unstubAllEnvs()
    if (directory) await rm(directory, { force: true, recursive: true })
})

const config = (): CustomProviderConfig => ({ name: 'Offline fixture', baseUrl, preset: null, contextWindow: 8192, vision: false,
    models: [{ id: modelId, contextWindow: null, vision: false, source: 'manual' }],
    policy: { reviewedOrigin: new URL(baseUrl).origin, allowHttp: true, allowPrivate: true } })

function settings(input: unknown, nonce = launch) {
    return binding.routes.request('/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rerun-launch-nonce': nonce }, body: JSON.stringify(input) })
}
function change(change: CustomProviderChange, nonce?: string) { return settings({ action: 'change', change }, nonce) }
function create() {
    return { action: 'create', requestId: crypto.randomUUID(), workspaceId: 1, connectionId, config: config(), apiKey: fixtureKey } as const
}
async function selectedAgent() {
    const connection = await findConnection(connectionId)
    expect(connection).toBeTruthy()
    return { id: 'fixture-agent', config: agentConfigSchema.parse({ name: 'Fixture', connectionId, provider: 'custom', model: modelId }),
        resolved: { connection, provider: 'custom' as const, model: modelId }, soul: '', install: '', env: {} }
}

test('registered custom Settings, catalog and exact turn use encrypted credentials through the pinned transport', async () => {
    const input = create()
    expect((await change(input, 'stale')).status).toBe(409)
    expect((await change({ ...input, workspaceId: 2 })).status).toBe(403)
    await expect(createConnection({ provider: 'custom', name: 'Bypass', models: [modelId], extraModels: [], keys: {} })).rejects.toThrow('Custom endpoint Settings')
    const response = await change(input)
    expect(response.status).toBe(200)
    const receipt = await response.json()
    expect(receipt).toMatchObject({ status: 'recorded', recovered: false, identity: { workspaceId: 1, connectionId, revision: 1 } })
    expect(await (await change(input)).json()).toMatchObject({ ...receipt, recovered: true })
    expect((await change({ ...input, apiKey: 'changed-fixture' })).status).toBe(409)
    const storage = await state.db!.execute('SELECT ciphertext,snapshot FROM desktop_custom_connections')
    expect(storage.rows[0]?.ciphertext).toBeTruthy()
    expect(JSON.stringify(storage.rows)).not.toContain(fixtureKey)
    expect(JSON.stringify((await state.db!.execute('SELECT * FROM desktop_custom_connection_receipts')).rows)).not.toContain(fixtureKey)
    expect(await (await settings({ action: 'read', identity: receipt.identity })).text()).not.toContain(fixtureKey)
    binding.close()
    state.db!.close()
    state.db = createClient({ url: `file:${join(directory, 'custom.db')}` })
    binding = bindDesktopCustomProviders(1, launch, () => false)
    expect(await (await change(input)).json()).toMatchObject({ ...receipt, recovered: true })
    const catalog = (await listConnections()).find(item => item.id === connectionId)!
    expect(toSummary(catalog)).toMatchObject({ provider: 'custom', customRevision: 1, connected: true, models: [modelId] })
    const choice = await connectionRoutes.request('/default', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId, model: modelId }) })
    expect(choice.status).toBe(200)
    const agent = await selectedAgent()
    const resolved = resolveModel(agent)
    try {
        expect((await generateText({ model: resolved.model, prompt: 'Fixture only', maxRetries: 0 })).text).toBe('synthetic reply')
        expect(await streamText({ model: resolved.model, prompt: 'Fixture only', maxRetries: 0 }).text).toBe('synthetic stream')
    } finally { await resolved.close() }
    expect(requests).toEqual([
        { model: modelId, authorization: `Bearer ${fixtureKey}`, streaming: false },
        { model: modelId, authorization: `Bearer ${fixtureKey}`, streaming: true },
    ])
    expect(() => resolveModel(agent, { model: 'wrong-model' })).toThrow('offered')
    expect((await change({ action: 'disconnect', requestId: crypto.randomUUID(), identity: receipt.identity })).status).toBe(409)
})

test('a material revision change revokes a streaming lease and disconnect never falls back', async () => {
    const receipt = await (await change(create())).json()
    const agent = await selectedAgent()
    const model = modelFor(agent)
    holdStream = true
    const iterator = streamText({ model, prompt: 'Fixture only', maxRetries: 0 }).textStream[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toBe('synthetic stream')
    const update = await change({ action: 'update', requestId: crypto.randomUUID(), identity: receipt.identity, config: config(), clearSecret: true })
    expect(update.status).toBe(200)
    await abortSeen
    await expect(iterator.next()).rejects.toThrow()
    await expect(generateText({ model, prompt: 'Must not send stale revision', maxRetries: 0 })).rejects.toThrow()
    expect(requests).toHaveLength(1)
    const current = (await update.json()).identity
    expect(current.revision).toBe(2)
    const disconnected = await change({ action: 'disconnect', requestId: crypto.randomUUID(), identity: current })
    expect(disconnected.status).toBe(200)
    const old = await findConnection(connectionId)
    expect(old && isConnected(old)).toBe(false)
    expect((await listConnections()).some(item => item.id === connectionId)).toBe(false)
    expect(() => modelFor({ ...agent, resolved: { ...agent.resolved, connection: old } })).toThrow('current custom connection')
    expect((await state.db!.execute('SELECT ciphertext FROM desktop_custom_connections')).rows[0]?.ciphertext).toBeNull()
})

test('persists an advertised effort only for the current custom default and exact credential revision', async () => {
    const hosted = { ...config(), preset: 'xai' as const, baseUrl: 'https://api.x.ai/v1',
        policy: { reviewedOrigin: 'https://api.x.ai', allowHttp: false, allowPrivate: false } }
    const receipt = await (await change({ ...create(), config: hosted })).json()
    const snapshot: CustomProviderSnapshot = await (await settings({ action: 'read', identity: receipt.identity })).json()
    const published = { ...snapshot, catalog: { status: 'fresh', observedAt: 1, attemptedAt: 1,
        models: [{ ...hosted.models[0], source: 'discovered', reasoning: { supported: ['low', 'xhigh'], default: 'low' } }] } }
    await state.db!.execute({ sql: 'UPDATE desktop_custom_connections SET snapshot=? WHERE connection_id=?',
        args: [JSON.stringify(published), connectionId] })
    const app = new Hono().onError((error, ctx) => error instanceof HttpError
        ? ctx.json({ error: error.message }, error.status as 409) : ctx.text('Internal error', 500)).route('/', connectionRoutes)
    const choose = (reasoningEffort?: string | null, revision = 1) => app.request('/default', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId, model: modelId,
            ...(reasoningEffort !== undefined && { reasoningEffort, customReasoningRevision: revision }) }),
    })
    expect((await choose('xhigh')).status).toBe(409)
    expect((await choose()).status).toBe(200)
    expect((await choose('medium')).status).toBe(400)
    expect((await choose('xhigh', 2)).status).toBe(409)
    expect((await choose('xhigh')).status).toBe(200)
    expect(state.defaultModel).toMatchObject({ reasoningEffort: 'xhigh', customReasoningRevision: 1 })
    expect(await desktopCustomEffort((await selectedAgent()).resolved)).toBe('xhigh')
    expect((await change({ action: 'update', requestId: crypto.randomUUID(), identity: receipt.identity, config: hosted, apiKey: 'replacement-fixture' })).status).toBe(200)
    await expect(desktopCustomEffort((await selectedAgent()).resolved)).rejects.toThrow('provider connection changed')
    expect((await choose(null, 1)).status).toBe(409)
    expect((await choose(null, 2)).status).toBe(200)
    expect(state.defaultModel).toEqual({ connectionId, model: modelId })
    expect(await desktopCustomEffort((await selectedAgent()).resolved)).toBeUndefined()
    expect(requests).toHaveLength(0)
})
