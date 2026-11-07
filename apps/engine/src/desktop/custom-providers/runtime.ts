import { createOpenAI } from '@ai-sdk/openai'
import { generateText, streamText, wrapLanguageModel, type Prompt } from 'ai'
import { CUSTOM_DEFAULT_CONTEXT_WINDOW, type CustomProviderAuthority, type CustomProviderIdentity, type CustomProviderModel, type CustomProviderProbe } from '@rerun/contracts'
import { openrouterReasoningMiddleware } from '../../agents/openrouter-reasoning.js'
import { createPinnedProviderFetch, endpointBase } from './network.js'

type CustomGenerateInput = Omit<Parameters<typeof generateText>[0], 'model' | 'prompt' | 'messages'> & Prompt
type CustomStreamInput = Omit<Parameters<typeof streamText>[0], 'model' | 'prompt' | 'messages'> & Prompt

export function parseCustomModels(body: unknown): CustomProviderModel[] {
    const rows = Array.isArray(body) ? body : body && typeof body === 'object' && 'data' in body && Array.isArray(body.data) ? body.data : null
    if (!rows || rows.length > 256) throw new Error('Custom catalog unavailable.')
    const models = new Map<string, CustomProviderModel>()
    for (const value of rows) {
        if (!value || typeof value !== 'object') continue
        const row = value as Record<string,unknown>, id = typeof row.id === 'string' ? row.id.trim() : ''
        if (!id || id.length > 256 || models.has(id)) continue
        const context = [row.context_length,row.max_model_len,row.context_window,row.max_context_length].find(n => typeof n === 'number' && Number.isInteger(n) && n >= 256 && n <= 10_000_000)
        models.set(id, { id, contextWindow: typeof context === 'number' ? context : null, vision: false, source: 'discovered' })
    }
    return [...models.values()]
}
export function createCustomProviderRuntime(authority: CustomProviderAuthority) {
    const work = new Set<{ identity: CustomProviderIdentity; abort: AbortController }>()
    let closed = false
    const unsubscribe = authority.subscribe(changed => {
        for (const job of work) if (job.identity.workspaceId === changed.workspaceId && job.identity.connectionId === changed.connectionId) job.abort.abort()
    })
    async function lease(identity: CustomProviderIdentity, stop: AbortSignal) {
        if (closed) throw new Error('Custom provider runtime closed.')
        const job = { identity: { ...identity }, abort: new AbortController() }; work.add(job)
        const signal = AbortSignal.any([stop, job.abort.signal])
        const close = () => { job.abort.abort(); work.delete(job) }
        const check = async (active = signal) => { active.throwIfAborted(); await authority.assertCurrent(identity, active); active.throwIfAborted() }
        try {
            await check(); const snapshot = await authority.read(identity, signal); await check()
            if (snapshot.state !== 'configured' || snapshot.workspaceId !== identity.workspaceId || snapshot.connectionId !== identity.connectionId || snapshot.revision !== identity.revision) throw new Error('Custom connection unavailable.')
            const key = await authority.credential(identity, signal); await check()
            const network = createPinnedProviderFetch(snapshot.config, check, signal)
            return { snapshot, key, network, check, close, signal }
        } catch { close(); throw new Error('Custom connection unavailable or stale.') }
    }
    async function resolveModel(identity: CustomProviderIdentity, modelId: string, stop: AbortSignal) {
            const bound = await lease(identity, stop)
            const selected = bound.snapshot.config.models.find(row => row.id === modelId)
            if (!selected) { bound.close(); throw new Error('Choose a model offered by this exact connection.') }
            const discovered = bound.snapshot.catalog.models.find(row => row.id === modelId)
            const window = discovered?.contextWindow ?? selected.contextWindow ?? bound.snapshot.config.contextWindow ?? CUSTOM_DEFAULT_CONTEXT_WINDOW
            const provider = createOpenAI({ baseURL: endpointBase(bound.snapshot.config), apiKey: bound.key ?? 'none', fetch: async (url, init) => {
                const headers = new Headers(init?.headers)
                if (!bound.key) headers.delete('authorization')
                return bound.network(url, { ...init, headers })
            } })
            return { model: wrapLanguageModel({ model: provider.chat(modelId), middleware: [openrouterReasoningMiddleware, { specificationVersion: 'v3', transformParams: async ({ params }) => { if (params.maxOutputTokens && params.maxOutputTokens >= window) throw new Error('Requested output exceeds custom model context window.'); return params } }] }), contextWindow: window, vision: selected.vision || bound.snapshot.config.vision, close: bound.close, signal: bound.signal }
        }
    return {
        model: resolveModel,
        async oneShot(identity: CustomProviderIdentity, modelId: string, input: CustomGenerateInput, stop: AbortSignal) {
            const bound = await resolveModel(identity, modelId, stop)
            try { const result = await generateText({ ...input, model: bound.model, abortSignal: AbortSignal.any([bound.signal, input.abortSignal ?? stop]) }); await authority.assertCurrent(identity, bound.signal); return result }
            finally { bound.close() }
        },
        async stream(identity: CustomProviderIdentity, modelId: string, input: CustomStreamInput, stop: AbortSignal) {
            const bound = await resolveModel(identity, modelId, stop)
            try { return { result: streamText({ ...input, model: bound.model, abortSignal: AbortSignal.any([bound.signal, input.abortSignal ?? stop]) }), close: bound.close, contextWindow: bound.contextWindow, vision: bound.vision } }
            catch { bound.close(); throw new Error('Custom stream could not start.') }
        },
        async probe(identity: CustomProviderIdentity, manualModel: string | undefined, stop: AbortSignal): Promise<CustomProviderProbe> {
            const bound = await lease(identity, AbortSignal.any([stop, AbortSignal.timeout(30_000)]))
            let status: CustomProviderProbe['status'] = 'unavailable', models: CustomProviderModel[] = [], problem: CustomProviderProbe['problem'] = 'not_listed', manualUsable = false
            try {
                const headers: Record<string, string> = bound.key ? { Authorization: `Bearer ${bound.key}` } : {}
                try {
                    const response = await bound.network(`${endpointBase(bound.snapshot.config)}/models`, { headers, signal: bound.signal })
                    if (response.status === 401 || response.status === 403) problem = 'unauthorized'
                    else if (response.ok) { models = parseCustomModels(await response.json()); status = models.length ? 'fresh' : 'empty'; problem = null }
                    else await response.body?.cancel()
                } catch { bound.signal.throwIfAborted(); problem = 'unreachable' }
                if (manualModel && problem !== 'unauthorized') {
                    if (!bound.snapshot.config.models.some(row => row.id === manualModel)) throw new Error('Manual model is not configured.')
                    const response = await bound.network(`${endpointBase(bound.snapshot.config)}/chat/completions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: manualModel, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 1 }), signal: bound.signal })
                    if (response.ok) { const body = await response.json(); manualUsable = Array.isArray(body?.choices) && body.choices.length > 0; problem = manualUsable ? problem : 'model_refused' }
                    else { await response.body?.cancel(); problem = response.status === 401 || response.status === 403 ? 'unauthorized' : 'model_refused' }
                }
                await bound.check()
                const result: CustomProviderProbe = { identity, status, models, problem, manualModel: manualModel ?? null, manualUsable, observedAt: Date.now() }
                await authority.recordProbe(identity, result, bound.signal); await bound.check()
                return result
            } finally { bound.close() }
        },
        close() { closed = true; unsubscribe(); for (const job of work) job.abort.abort(); work.clear() },
    }
}
