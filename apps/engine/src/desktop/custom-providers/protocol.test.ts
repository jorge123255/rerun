import { expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import type { CustomProviderAuthority, CustomProviderConfig, CustomProviderIdentity, CustomProviderSnapshot } from '@rerun/contracts'
import { createCustomProviderRuntime } from './runtime.js'
import { probeCustomDraft } from './draft-probe.js'
const fake = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./network.js', () => ({ endpointBase: (config: CustomProviderConfig) => config.baseUrl, createPinnedProviderFetch: () => fake.request }))
const identity: CustomProviderIdentity = { workspaceId: 1, connectionId: 'custom-exact', revision: 1 }
function fixture(options: { config?: CustomProviderConfig; key?: string } = {}) {
    let current = true, listener: (i: CustomProviderIdentity) => void = () => {}
    const snapshot: CustomProviderSnapshot = { ...identity, configuredSecret: Boolean(options.key), state: 'configured', config: options.config ?? { name: 'Fixture', baseUrl: 'https://reviewed.example/v1', preset: null, models: [{ id: 'vendor/exact:tag', contextWindow: null, vision: false, source: 'manual' }], contextWindow: 8192, vision: false, policy: { reviewedOrigin: 'https://reviewed.example', allowHttp: false, allowPrivate: false } }, catalog: { status: 'never', models: [], observedAt: null, attemptedAt: null } }
    const authority: CustomProviderAuthority = {
        read: async requested => { if (requested.workspaceId !== 1) throw new Error('workspace'); return snapshot },
        credential: async () => options.key ?? null,
        assertCurrent: async (requested, signal) => { signal.throwIfAborted(); if (!current || requested.workspaceId !== 1 || requested.revision !== 1) throw new Error('stale') },
        change: async () => { throw new Error('fixture does not implement effects') }, recordProbe: vi.fn(async () => {}),
        subscribe: callback => { listener = callback; return () => {} },
    }
    return { runtime: createCustomProviderRuntime(authority), authority, replace() { current = false; listener({ ...identity, revision: 2 }) } }
}
it('performs an optional-key one-shot on the exact model and projects compaction context', async () => {
    fake.request.mockImplementation(async (_url, init) => {
        expect(new Headers(init.headers).has('authorization')).toBe(false)
        expect(JSON.parse(init.body).model).toBe('vendor/exact:tag')
        return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: 'vendor/exact:tag', choices: [{ index: 0, message: { role: 'assistant', content: 'Actual fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
    })
    const { runtime } = fixture()
    const bound = await runtime.model(identity, 'vendor/exact:tag', new AbortController().signal)
    expect(bound.contextWindow).toBe(8192); expect(bound.vision).toBe(false); bound.close()
    const result = await runtime.oneShot(identity, 'vendor/exact:tag', { prompt: 'Fixture prompt' }, new AbortController().signal)
    expect(result.text).toBe('Actual fixture answer'); runtime.close()
})

it.each([
    { preset: 'xai', baseUrl: 'https://api.x.ai/v1', catalogPath: 'language-models', envelope: 'models' },
    { preset: 'kimi-platform', baseUrl: 'https://api.moonshot.ai/v1', catalogPath: 'models', envelope: 'data' },
] as const)('discovers $preset models before and after save and uses its exact model for a keyed reply', async ({ preset, baseUrl, catalogPath, envelope }) => {
    const model = `synthetic-${preset}-text`
    const key = `synthetic-key-for-${preset}`
    const requests: string[] = []
    fake.request.mockImplementation(async (url, init) => {
        const address = String(url)
        requests.push(address)
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${key}`)
        if (address === `${baseUrl}/${catalogPath}`) return Response.json({ [envelope]: [{ id: model, context_length: 16384 }] })
        expect(address).toBe(`${baseUrl}/chat/completions`)
        expect(JSON.parse(init.body).model).toBe(model)
        return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model, choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture reply' }, finish_reason: 'stop' }] })
    })
    const signal = new AbortController().signal
    const policy = { reviewedOrigin: new URL(baseUrl).origin, allowHttp: false, allowPrivate: false }
    const draft = await probeCustomDraft({ action: 'probe_draft', requestId: crypto.randomUUID(), workspaceId: 1, baseUrl, policy, apiKey: key }, async () => {}, signal)
    expect(draft).toMatchObject({ status: 'fresh', models: [{ id: model, contextWindow: 16384 }] })
    const { runtime } = fixture({ key, config: { name: preset, preset, baseUrl, policy, models: draft.models, contextWindow: null, vision: false } })
    try {
        expect(await runtime.probe(identity, undefined, signal)).toMatchObject({ status: 'fresh', models: draft.models })
        expect((await runtime.oneShot(identity, model, { prompt: 'Fixture prompt' }, signal)).text).toBe('Fixture reply')
        expect(requests).toEqual([`${baseUrl}/${catalogPath}`, `${baseUrl}/${catalogPath}`, `${baseUrl}/chat/completions`])
    } finally { runtime.close() }
})
it('separates streaming reasoning_content from answer text through the existing middleware', async () => {
    const frames = [
        { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Private thought' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    fake.request.mockResolvedValue(new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
    const { runtime } = fixture(), bound = await runtime.model(identity, 'vendor/exact:tag', new AbortController().signal)
    const result = streamText({ model: bound.model, prompt: 'Fixture', abortSignal: bound.signal })
    expect(await result.text).toBe('Answer')
    expect(await result.reasoningText).toContain('Private thought')
    bound.close(); runtime.close()
})
it('never adopts another workspace/revision/model and aborts an obsolete lease on replacement', async () => {
    const { runtime, replace } = fixture()
    await expect(runtime.model({ ...identity, workspaceId: 2 }, 'vendor/exact:tag', new AbortController().signal)).rejects.toThrow()
    await expect(runtime.model(identity, 'same-name-replacement', new AbortController().signal)).rejects.toThrow()
    const bound = await runtime.model(identity, 'vendor/exact:tag', new AbortController().signal)
    replace(); expect(bound.signal.aborted).toBe(true)
    bound.close(); runtime.close()
})
it('preserves discovery unavailable while explicitly confirming a manually configured model', async () => {
    fake.request.mockImplementation(async url => String(url).endsWith('/models') ? new Response(null, { status: 404 }) : Response.json({ choices: [{ message: { content: 'ok' } }] }))
    const { runtime, authority } = fixture()
    const result = await runtime.probe(identity, 'vendor/exact:tag', new AbortController().signal)
    expect(result).toMatchObject({ status: 'unavailable', problem: 'not_listed', manualUsable: true })
    expect(authority.recordProbe).toHaveBeenCalledOnce(); runtime.close()
})
