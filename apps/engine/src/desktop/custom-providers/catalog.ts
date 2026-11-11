import { DESKTOP_XAI_BASE_URL, type CustomProviderModel } from '@rerun/contracts'

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

export function customModelCatalog(base: string) {
    if (base !== DESKTOP_XAI_BASE_URL) return { url: `${base}/models`, parse: parseCustomModels }
    return {
        // xAI's general catalog also offers image and video generation models.
        url: `${base}/language-models`,
        parse(body: unknown) {
            return parseCustomModels(body && typeof body === 'object' && 'models' in body ? body.models : body)
        },
    }
}
