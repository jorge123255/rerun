import { expect, test, vi } from 'vitest'
import { DESKTOP_OLLAMA, connectionSummarySchema, desktopOllamaKind, type CustomProviderModel, type CustomProviderSnapshot } from '@rerun/contracts'
import { buildDesktopModelView } from '../chat-model'
import {
    OLLAMA_DEFAULT_LOCK, OLLAMA_NOT_RUNNING, connectLocalOllama, ollamaMessage, ollamaModelPlan, refreshOllama, removeOllama, saveOllamaCloudKey, type OllamaAdapter,
} from './index'

const signal = new AbortController().signal
const model = (id: string, tools?: boolean, vision = false): CustomProviderModel => ({ id, contextWindow: null, vision, source: 'discovered', ...(tools !== undefined && { tools }) })
const chat = model('synthetic-chat:latest', true, true), plain = model('synthetic-plain:7b', false), fresh = model('synthetic-new:12b', true)
const syntheticKey = 'synthetic-only-ollama-key'
const connection = { id: '33333333-3333-4333-8333-333333333333', revision: 3 }

function adapter(options: { listed?: CustomProviderModel[]; running?: boolean; enabled?: CustomProviderModel[]; proof?: 'unauthorized' | 'model_refused' | null } = {}) {
    const running = options.running ?? true, listed = options.listed ?? [chat, plain]
    const read = vi.fn<OllamaAdapter['read']>(async identity => ({ ok: true, value: {
        ...identity, configuredSecret: false, state: 'configured', catalog: { status: 'never', models: [], observedAt: null, attemptedAt: null },
        config: { name: 'Ollama (this Mac)', baseUrl: DESKTOP_OLLAMA.ollama.baseUrl, preset: null, models: options.enabled ?? [chat], contextWindow: null, vision: false,
            policy: { reviewedOrigin: 'http://127.0.0.1:11434', allowHttp: true, allowPrivate: true } },
    } satisfies CustomProviderSnapshot }))
    const probe = vi.fn<OllamaAdapter['probe']>(async identity => ({ ok: true, value: { identity, status: running ? 'fresh' : 'unavailable', models: running ? listed : [],
        problem: running ? null : 'unreachable', manualModel: null, manualUsable: false, observedAt: 1 } }))
    const probeDraft = vi.fn<OllamaAdapter['probeDraft']>(async draft => ({ ok: true, value: { requestId: draft.requestId, workspaceId: draft.workspaceId,
        status: running ? 'fresh' : 'unavailable', models: running ? listed : [], problem: !running ? 'unreachable' : draft.manualModel ? options.proof ?? null : null,
        manualModel: draft.manualModel ?? null, manualUsable: !!draft.manualModel && !options.proof, observedAt: 1 } }))
    const change = vi.fn<OllamaAdapter['change']>(async body => ({ ok: true, value: { requestId: body.requestId, action: body.action, status: 'recorded', recovered: false,
        identity: body.action === 'create' ? { workspaceId: body.workspaceId, connectionId: body.connectionId, revision: 1 } : { ...body.identity, revision: body.identity.revision + 1 } } }))
    return { read, probe, probeDraft, change }
}

test('lists the models of the Ollama app before anything is saved, at the fixed loopback address', async () => {
    const client = adapter()
    const view = await refreshOllama({ adapter: client, kind: 'ollama', workspaceId: 1, connection: null, defaultModelId: null, signal })
    expect(view).toMatchObject({ state: 'ready', changed: false, withoutTools: ['synthetic-plain:7b'], toolsKnown: true })
    expect(view.models).toEqual([chat])
    expect(client.probeDraft.mock.calls[0]![0]).toMatchObject({ action: 'probe_draft', workspaceId: 1, baseUrl: 'http://127.0.0.1:11434/v1',
        policy: { reviewedOrigin: 'http://127.0.0.1:11434', allowHttp: true, allowPrivate: true } })
    expect(client.probeDraft.mock.calls[0]![0]).not.toHaveProperty('apiKey')
    expect(client.change).not.toHaveBeenCalled()
})

test('says Ollama is not running, and keeps a saved connection and its models', async () => {
    const closed = adapter({ running: false })
    const draft = await refreshOllama({ adapter: closed, kind: 'ollama', workspaceId: 1, connection: null, defaultModelId: null, signal })
    expect(draft).toMatchObject({ state: 'not-running', models: [] })
    expect(ollamaMessage('ollama', draft.state)).toBe(OLLAMA_NOT_RUNNING)
    const saved = await refreshOllama({ adapter: closed, kind: 'ollama', workspaceId: 1, connection, defaultModelId: null, signal })
    expect(saved).toMatchObject({ state: 'not-running', models: [chat], changed: false })
    expect(closed.change).not.toHaveBeenCalled()
    // The cloud being out of reach is not "Ollama is not running".
    expect((await refreshOllama({ adapter: closed, kind: 'ollama-cloud', workspaceId: 1, connection, defaultModelId: null, signal })).state).toBe('unreachable')
})

test('a changed list is written back once; an unchanged list writes nothing', async () => {
    const same = adapter()
    expect(await refreshOllama({ adapter: same, kind: 'ollama', workspaceId: 1, connection, defaultModelId: null, signal })).toMatchObject({ state: 'ready', changed: false })
    expect(same.change).not.toHaveBeenCalled()

    const pulled = adapter({ listed: [chat, plain, fresh] })
    const view = await refreshOllama({ adapter: pulled, kind: 'ollama', workspaceId: 1, connection, defaultModelId: null, signal })
    expect(view).toMatchObject({ state: 'ready', changed: true })
    const update = pulled.change.mock.calls[0]![0]
    expect(update).toMatchObject({ action: 'update', identity: { workspaceId: 1, connectionId: connection.id, revision: 3 }, clearSecret: false })
    if (update.action !== 'update') throw new Error('expected update')
    expect(update.config.models).toEqual([chat, fresh])
    expect(update.config).toMatchObject({ name: 'Ollama (this Mac)', baseUrl: 'http://127.0.0.1:11434/v1', preset: null })
    expect(update).not.toHaveProperty('apiKey')
})

test('names the models that cannot call tools and never drops the workspace default', () => {
    expect(ollamaModelPlan([chat, plain], [], null)).toEqual({ models: [chat], withoutTools: ['synthetic-plain:7b'], toolsKnown: true })
    // The default stays offered even when Ollama says it has no tools, or no longer lists it.
    expect(ollamaModelPlan([chat, plain], [plain], plain.id).models).toEqual([chat, plain])
    expect(ollamaModelPlan([chat], [fresh], fresh.id).models).toEqual([chat, fresh])
    // An older Ollama does not say: everything is offered and the unknown is stated.
    const old = [model('synthetic-old:latest')]
    expect(ollamaModelPlan(old, [], null)).toEqual({ models: old, withoutTools: [], toolsKnown: false })
})

test('connects the local Ollama without any key', async () => {
    const client = adapter()
    expect(await connectLocalOllama({ adapter: client, workspaceId: 1, models: [chat], name: 'Ollama (this Mac)', signal })).toEqual({ ok: true })
    const created = client.change.mock.calls[0]![0]
    expect(created).toMatchObject({ action: 'create', workspaceId: 1, config: { baseUrl: 'http://127.0.0.1:11434/v1', models: [chat] } })
    expect(created).not.toHaveProperty('apiKey')
    if (created.action === 'create') expect(created.connectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect((await connectLocalOllama({ adapter: client, workspaceId: 1, models: [], name: 'Ollama (this Mac)', signal })).ok).toBe(false)
})

test('saves, replaces and removes the Ollama Cloud key through the encrypted connection store', async () => {
    const client = adapter({ listed: [chat, plain] })
    const saved = await saveOllamaCloudKey({ adapter: client, workspaceId: 1, connection: null, apiKey: `  ${syntheticKey}  `, defaultModelId: null, name: 'Ollama Cloud', signal })
    expect(saved).toEqual({ ok: true })
    // The key is proved against ollama.com before it is stored, then handed to the engine once.
    expect(client.probeDraft.mock.calls.map(([draft]) => [draft.baseUrl, draft.apiKey, draft.manualModel])).toEqual([
        ['https://ollama.com/v1', syntheticKey, undefined], ['https://ollama.com/v1', syntheticKey, chat.id]])
    expect(client.probeDraft.mock.calls[0]![0].policy).toEqual({ reviewedOrigin: 'https://ollama.com', allowHttp: false, allowPrivate: false })
    expect(client.change.mock.calls[0]![0]).toMatchObject({ action: 'create', apiKey: syntheticKey, config: { name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', models: [chat] } })
    expect(JSON.stringify(saved)).not.toContain(syntheticKey)

    const replaced = await saveOllamaCloudKey({ adapter: client, workspaceId: 1, connection, apiKey: 'synthetic-replacement-key', defaultModelId: null, name: 'Ollama Cloud', signal })
    expect(replaced).toEqual({ ok: true })
    expect(client.change.mock.calls[1]![0]).toMatchObject({ action: 'update', identity: { connectionId: connection.id, revision: 3 }, apiKey: 'synthetic-replacement-key', clearSecret: false })

    expect(await removeOllama({ adapter: client, workspaceId: 1, connection, isDefault: true, signal })).toEqual({ ok: false, message: OLLAMA_DEFAULT_LOCK })
    expect(client.change).toHaveBeenCalledTimes(2)
    expect(await removeOllama({ adapter: client, workspaceId: 1, connection, isDefault: false, signal })).toEqual({ ok: true })
    expect(client.change.mock.calls[2]![0]).toMatchObject({ action: 'disconnect', identity: { workspaceId: 1, connectionId: connection.id, revision: 3 } })
})

test('a refused test request is said plainly, an unusable key is never sent to the store', async () => {
    const refused = adapter({ proof: 'unauthorized' })
    const result = await saveOllamaCloudKey({ adapter: refused, workspaceId: 1, connection: null, apiKey: syntheticKey, defaultModelId: null, name: 'Ollama Cloud', signal })
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining('refused a test request') })
    expect(JSON.stringify(result)).not.toContain(syntheticKey)
    for (const apiKey of ['', '   ', 'two words', 'smart “quotes”']) {
        const client = adapter()
        expect((await saveOllamaCloudKey({ adapter: client, workspaceId: 1, connection: null, apiKey, defaultModelId: null, name: 'Ollama Cloud', signal })).ok).toBe(false)
        expect(client.probeDraft).not.toHaveBeenCalled()
        expect(client.change).not.toHaveBeenCalled()
    }
    const offline = adapter({ running: false })
    expect((await saveOllamaCloudKey({ adapter: offline, workspaceId: 1, connection: null, apiKey: syntheticKey, defaultModelId: null, name: 'Ollama Cloud', signal })).ok).toBe(false)
    expect(offline.change).not.toHaveBeenCalled()
})

test('an Ollama model can be the workspace default, a coworker model and a chat model, under its own name and logo', () => {
    const local = connectionSummarySchema.parse({ id: connection.id, name: 'Ollama (this Mac)', provider: 'custom', baseUrl: 'http://127.0.0.1:11434/v1',
        models: [chat.id, fresh.id], extraModels: [], createdAt: '2026-11-15T00:00:00.000Z', connected: true, customRevision: 3 })
    const cloud = connectionSummarySchema.parse({ id: '44444444-4444-4444-8444-444444444444', name: 'Ollama Cloud', provider: 'custom', baseUrl: 'https://ollama.com/v1',
        models: ['synthetic-hosted:31b'], extraModels: [], createdAt: '2026-11-15T00:00:00.000Z', connected: true, customRevision: 1 })
    const other = connectionSummarySchema.parse({ ...local, id: '55555555-5555-4555-8555-555555555555', name: 'My server', baseUrl: 'http://localhost:11434/v1' })
    expect([local, cloud, other].map(desktopOllamaKind)).toEqual(['ollama', 'ollama-cloud', null])
    const connections = [local, cloud, other]

    const workspace = buildDesktopModelView({ connections, workspace: { connectionId: local.id, model: chat.id }, coworker: null, conversation: null, presets: true })
    expect(workspace.effective).toMatchObject({ source: 'workspace', connectionId: local.id, provider: 'custom', brand: 'ollama', name: 'Ollama (this Mac)', model: chat.id, available: true })
    expect(workspace.catalog.map(group => [group.name, group.brand])).toEqual([['Ollama (this Mac)', 'ollama'], ['Ollama Cloud', 'ollama-cloud'], ['My server', undefined]])
    // With only Ollama connected, Rerun Fast, Balanced and Smart are not offered: they never fall to it.
    expect(workspace.catalog.some(group => group.provider === 'rerun')).toBe(false)

    const coworker = buildDesktopModelView({ connections, workspace: { connectionId: local.id, model: chat.id },
        coworker: { connectionId: cloud.id, provider: 'custom', model: 'synthetic-hosted:31b' }, conversation: null })
    expect(coworker.effective).toMatchObject({ source: 'coworker', connectionId: cloud.id, brand: 'ollama-cloud', name: 'Ollama Cloud', available: true })

    const conversation = buildDesktopModelView({ connections, workspace: null, coworker: null, conversation: { connectionId: local.id, model: fresh.id } })
    expect(conversation.effective).toMatchObject({ source: 'conversation', connectionId: local.id, model: fresh.id, brand: 'ollama', available: true })
    // A model Ollama no longer serves is shown as unavailable instead of silently swapped.
    const gone = buildDesktopModelView({ connections, workspace: null, coworker: null, conversation: { connectionId: local.id, model: 'synthetic-removed:1b' } })
    expect(gone.effective.available).toBe(false)
})
