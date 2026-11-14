import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_OPENCODE_CONNECTION_ID, DESKTOP_OPENCODE_SNAPSHOT, desktopOpencodeConnectionView } from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { desktopOpencodeConnectionRoutes } from './connection-routes.js'
import { createDesktopOpencodeConnectionStore } from './connection-store.js'

afterEach(() => vi.unstubAllEnvs())
const key = 'oc_sk_synthetic_first'
const replacement = 'oc_sk_synthetic_replacement'

it('keeps the OpenCode key encrypted and revision-bound through settings changes and a store reopen', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'f1'.repeat(32))
    const directory = await mkdtemp(join(tmpdir(), 'desktop-opencode-'))
    const path = join(directory, 'desktop-opencode.env')
    const signal = new AbortController().signal
    const readDefault = vi.fn(async (): Promise<{ connectionId: string; model: string } | null> => null)
    const options = { path, workspaceId: 1, admit: () => 0, knownModels: () => DESKTOP_OPENCODE_SNAPSHOT.map(model => model.id), readDefault }
    const store = createDesktopOpencodeConnectionStore(options)
    const engine = new Hono().route('/desktop/opencode/connection', desktopOpencodeConnectionRoutes(store, 'test-launch'))
    const send = (body?: unknown, launch = 'test-launch') => engine.request('/desktop/opencode/connection', {
        method: body ? 'POST' : 'GET',
        headers: { 'x-rerun-launch-nonce': launch, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    try {
        expect((await send(undefined, 'stale-launch')).status).toBe(409)
        expect(await (await send()).json()).toEqual({ connection: null })
        const initial = { action: 'key', workspaceId: 1, expectedRevision: null, apiKey: key }
        expect((await send({ ...initial, workspaceId: 2 })).status).toBe(409)
        expect((await send({ ...initial, apiKey: 'sk-not-opencode' })).status).toBe(400)
        const created = await send(initial)
        expect(created.status).toBe(200)
        const createdBody = await created.json()
        expect(createdBody.connection).not.toHaveProperty('apiKey')
        const view = desktopOpencodeConnectionView.parse(createdBody.connection)
        expect(view.consoleEnabled).toBe(false)
        expect(view.enabledModelIds).not.toContain('go/beam-free')
        expect(await store.credential(view.revision, signal)).toBe(key)
        expect(await readFile(path, 'utf8')).toMatch(/^RERUN-DESKTOP-ENV-1\n/)
        expect(await readFile(path, 'utf8')).not.toContain(key)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect((await send(initial)).status).toBe(409)

        const next = { ...initial, apiKey: replacement, expectedRevision: view.revision }
        const rotated = desktopOpencodeConnectionView.parse((await (await send(next)).json()).connection)
        const reopened = createDesktopOpencodeConnectionStore(options)
        await expect(reopened.view(signal)).resolves.toEqual(rotated)
        await expect(reopened.credential(view.revision, signal)).rejects.toThrow(/changed/)
        await expect(reopened.credential(rotated.revision, signal)).resolves.toBe(replacement)
        await expect(createDesktopOpencodeConnectionStore({ ...options, workspaceId: 2 }).view(signal)).rejects.toThrow(/changed/)

        const modelChange = { action: 'models', workspaceId: 1, expectedRevision: rotated.revision,
            enabledModelIds: [rotated.defaultModelId, 'go/beam-free'], defaultModelId: rotated.defaultModelId, consoleEnabled: false }
        expect((await send({ ...modelChange, enabledModelIds: [...modelChange.enabledModelIds, 'console/claude-fable-5'] })).status).toBe(400)
        const updated = desktopOpencodeConnectionView.parse((await (await send(modelChange)).json()).connection)
        expect(updated.enabledModelIds).toContain('go/beam-free')
        const remove = { action: 'disconnect', workspaceId: 1, expectedRevision: updated.revision }
        readDefault.mockResolvedValueOnce({ connectionId: DESKTOP_OPENCODE_CONNECTION_ID, model: updated.defaultModelId })
        expect((await send(remove)).status).toBe(409)
        expect(await (await send(remove)).json()).toEqual({ connection: null })
        await expect(reopened.view(signal)).resolves.toBeNull()
        await expect(reopened.credential(updated.revision, signal)).rejects.toThrow(/changed/)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

it('keeps a write private if the workspace freezes before the encrypted rename', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'f2'.repeat(32))
    const directory = await mkdtemp(join(tmpdir(), 'desktop-opencode-frozen-'))
    const path = join(directory, 'desktop-opencode.env')
    const admit = vi.fn(() => 0).mockImplementationOnce(() => 0).mockImplementationOnce(() => 0).mockImplementationOnce(() => 0)
        .mockImplementationOnce(() => { throw new HttpError(409, 'This workspace is switching.') })
    try {
        const store = createDesktopOpencodeConnectionStore({ path, workspaceId: 1, admit, knownModels: () => [], readDefault: async () => null })
        await expect(store.change({ action: 'key', workspaceId: 1, expectedRevision: null, apiKey: key }, new AbortController().signal)).rejects.toThrow(/switching/)
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(path + '.tmp')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

it('uses the exact saved key only at SDK send and refuses a captured model after key replacement', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'f3'.repeat(32))
    const directory = await mkdtemp(join(tmpdir(), 'desktop-opencode-sdk-'))
    const signal = new AbortController().signal
    const { registerDesktopOpencodeConnection, readDesktopOpencodeConnection } = await import('./registry.js')
    const { modelFor } = await import('../../agents/providers.js')
    const { generateText } = await import('ai')
    const store = createDesktopOpencodeConnectionStore({ path: join(directory, 'opencode.env'), workspaceId: 1, admit: () => 0,
        knownModels: () => DESKTOP_OPENCODE_SNAPSHOT.map(model => model.id), readDefault: async () => null })
    registerDesktopOpencodeConnection(store)
    try {
        const initial = await store.change({ action: 'key', workspaceId: 1, expectedRevision: null, apiKey: key }, signal)
        const connection = (await readDesktopOpencodeConnection())!
        expect(connection.env).toEqual({})
        expect(connection.config.models).toContain(initial!.defaultModelId)
        expect(connection.config.models).not.toContain('go/beam-free')
        expect(JSON.stringify(connection)).not.toContain(key)
        const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
            expect(String(url)).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
            expect(JSON.parse(String(init?.body)).model).toBe('deepseek-v4-pro')
            return Response.json({ id: 'completion', created: 1, model: 'deepseek-v4-pro',
                choices: [{ index: 0, message: { role: 'assistant', content: 'OpenCode fixture answer' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
        })
        vi.stubGlobal('fetch', fetch)
        const { provider, models: [selected] } = connection.config
        const agent = { resolved: { connection, provider, model: selected! } } as import('../../agents/types.js').LoadedAgent
        const model = modelFor(agent)
        expect(fetch).not.toHaveBeenCalled()
        const result = await generateText({ model, prompt: 'Synthetic greeting', maxRetries: 0 })
        expect(result.text).toBe('OpenCode fixture answer')
        await store.change({ action: 'key', workspaceId: 1, expectedRevision: initial!.revision, apiKey: replacement }, signal)
        await expect(generateText({ model, prompt: 'Synthetic greeting', maxRetries: 0 })).rejects.toThrow(/connection changed/i)
        expect(fetch).toHaveBeenCalledOnce()
    } finally {
        registerDesktopOpencodeConnection(undefined)
        vi.unstubAllGlobals()
        await rm(directory, { recursive: true, force: true })
    }
})
