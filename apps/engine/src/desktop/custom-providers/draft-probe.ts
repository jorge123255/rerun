import { type CustomProviderConfig, type CustomProviderDraftProbe, type CustomProviderModel, type CustomProviderProbe } from '@rerun/contracts'
import { createPinnedProviderFetch, endpointBase } from './network.js'
import { parseCustomModels } from './runtime.js'

/** An explicit Settings action, before connection creation. Credentials remain ephemeral. */
export async function probeCustomDraft(input: CustomProviderDraftProbe, checkWorkspace: (signal: AbortSignal) => Promise<void>, stop: AbortSignal) {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(30_000)])
    const config: CustomProviderConfig = { name: 'Draft', baseUrl: input.baseUrl, policy: input.policy, preset: null, models: [], contextWindow: null, vision: false }
    const network = createPinnedProviderFetch(config, checkWorkspace, signal)
    const headers: Record<string, string> = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}
    let models: CustomProviderModel[] = [], status: CustomProviderProbe['status'] = 'unavailable', problem: CustomProviderProbe['problem'] = 'not_listed', manualUsable = false
    await checkWorkspace(signal)
    try {
        const response = await network(`${endpointBase(config)}/models`, { headers, signal })
        if (response.status === 401 || response.status === 403) problem = 'unauthorized'
        else if (response.ok) { models = parseCustomModels(await response.json()); status = models.length ? 'fresh' : 'empty'; problem = null }
        else await response.body?.cancel()
    } catch { signal.throwIfAborted(); problem = 'unreachable' }
    if (input.manualModel && problem !== 'unauthorized') {
        const response = await network(`${endpointBase(config)}/chat/completions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: input.manualModel, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 1 }), signal })
        if (response.ok) { const body = await response.json(); manualUsable = Array.isArray(body?.choices) && body.choices.length > 0; if (!manualUsable) problem = 'model_refused' }
        else { await response.body?.cancel(); problem = response.status === 401 || response.status === 403 ? 'unauthorized' : 'model_refused' }
    }
    await checkWorkspace(signal); signal.throwIfAborted()
    return { requestId: input.requestId, workspaceId: input.workspaceId, status, models, problem, manualModel: input.manualModel ?? null, manualUsable, observedAt: Date.now() }
}
