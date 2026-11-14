import { DESKTOP_XAI_BASE_URL, xaiReasoningLevel, type CustomProviderModel, type CustomProviderSnapshot } from '@rerun/contracts'
import { isKimiPlatform } from './kimi-reasoning.js'

const KIMI_K3_MODELS = new Set(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'])

function xaiReasoning(capabilities: unknown): CustomProviderModel['reasoning'] {
    if (!capabilities || typeof capabilities !== 'object') return
    const { reasoning_effort: levels, default_reasoning_effort: defaultLevel } = capabilities as Record<string, unknown>
    if (!Array.isArray(levels) || levels.length > 32) return
    const supported = [...new Set(levels.filter((level): level is NonNullable<CustomProviderModel['reasoning']>['supported'][number] => xaiReasoningLevel.safeParse(level).success))]
    if (!supported.length) return
    const preferred = xaiReasoningLevel.safeParse(defaultLevel)
    return { supported, ...(preferred.success && supported.includes(preferred.data) && { default: preferred.data }) }
}

export function parseCustomModels(body: unknown, includeXaiReasoning = false): CustomProviderModel[] {
    const rows = Array.isArray(body) ? body : body && typeof body === 'object' && 'data' in body && Array.isArray(body.data) ? body.data : null
    if (!rows || rows.length > 256) throw new Error('Custom catalog unavailable.')
    const models = new Map<string, CustomProviderModel>()
    for (const value of rows) {
        if (!value || typeof value !== 'object') continue
        const row = value as Record<string,unknown>, id = typeof row.id === 'string' ? row.id.trim() : ''
        if (!id || id.length > 256 || models.has(id)) continue
        const context = [row.context_length,row.max_model_len,row.context_window,row.max_context_length].find(n => typeof n === 'number' && Number.isInteger(n) && n >= 256 && n <= 10_000_000)
        const reasoning = includeXaiReasoning ? xaiReasoning(row.capabilities) : undefined
        models.set(id, { id, contextWindow: typeof context === 'number' ? context : null, vision: false, source: 'discovered', ...(reasoning && { reasoning }) })
    }
    return [...models.values()]
}

export function customModelCatalog(base: string) {
    if (base !== DESKTOP_XAI_BASE_URL) return { url: `${base}/models`, parse: parseCustomModels }
    return {
        // xAI's general catalog also offers image and video generation models.
        url: `${base}/language-models`,
        parse(body: unknown) {
            return parseCustomModels(body && typeof body === 'object' && 'models' in body ? body.models : body, true)
        },
    }
}

export function customCatalogReasoning(snapshot: CustomProviderSnapshot, model: string): CustomProviderModel['reasoning'] {
    if (snapshot.state !== 'configured' || !snapshot.configuredSecret || snapshot.catalog.status !== 'fresh') return
    const discovered = snapshot.catalog.models.find(entry => entry.id === model)
    if (!discovered) return
    if (isKimiPlatform(snapshot.config) && KIMI_K3_MODELS.has(model)) {
        // Kimi's model listing confirms account availability. Its API documentation defines these
        // levels for the exact K3 IDs, including the Highspeed variant.
        return { supported: ['low', 'high', 'max'], default: 'max' }
    }
    if (new URL(snapshot.config.baseUrl).href.replace(/\/+$/, '') === DESKTOP_XAI_BASE_URL) return discovered.reasoning
}
