import {
    CUSTOM_DEFAULT_CONTEXT_WINDOW,
    DESKTOP_CUSTOM_PRESETS,
    customProviderConfigSchema,
    type CustomProviderConfig,
    type CustomProviderModel,
    type CustomProviderProbe,
} from '@rerun/contracts'

/** Agent A's published implementation, including probe_draft. d98fe9ed is only the earlier contract commit. */
export const DESKTOP_CUSTOM_PROVIDER_CONTRACT_REVISION = '6ebc50dc94dc437a40f0218e6804acda115e1f7f'
export const DESKTOP_CUSTOM_PROVIDER_ROUTE = '/api/desktop/custom-providers'
export const MODELS_ON_AT_CONNECT = 10
export const CUSTOM_PROVIDER_HEADER = 'Custom endpoint'
export const CUSTOM_PROVIDER_HINT = 'Ollama, LM Studio, vLLM or any OpenAI-compatible server'
export const CONNECT_FAILED = 'Something went wrong. Please try again.'
export const UNAVAILABLE_MESSAGE = 'Custom provider request unavailable, cancelled or changed. Retry the same request to recover its receipt.'
export const OTHER_WORKSPACE = 'Custom connection belongs to another workspace.'
export const DEFAULT_LOCK = 'This is the default model. Pick another default first.'
export const LAST_MODEL_LOCK = 'Coworkers need at least one model from this source.'
export const RETIRED_MODEL = 'This saved model is no longer offered by a connected provider. Choose another, or follow the coworker or workspace default.'
export const NOT_LISTED_MESSAGE = 'This server does not list its models. Type the id of the one to run.'
export const CUSTOM_MODEL_HINT = 'Add a model the server serves but does not list'

export type DesktopCustomPreset = (typeof DESKTOP_CUSTOM_PRESETS)[number]

/** Desktop runs beside the machine, so local presets stay. Cloud billing is not the Mac authority. */
export function desktopPresets(): readonly DesktopCustomPreset[] {
    return DESKTOP_CUSTOM_PRESETS
}

export function uniqueName(base: string, taken: string[]): string {
    if (!taken.includes(base)) return base
    for (let n = 2; ; n += 1) {
        const candidate = `${base} ${n}`
        if (!taken.includes(candidate)) return candidate
    }
}

export function normalizeBase(value: string): string {
    return value.trim().replace(/\/+$/, '')
}

export function endpointReady(value: string): boolean {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 2048) return false
    try {
        const url = new URL(trimmed)
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash
    } catch {
        return false
    }
}

export function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).host
    } catch {
        return baseUrl
    }
}

export function presetForUrl(baseUrl: string): DesktopCustomPreset | null {
    const normalized = normalizeBase(baseUrl)
    return DESKTOP_CUSTOM_PRESETS.find(preset => preset.baseUrl === normalized) ?? null
}

export function keyRequiredFor(preset: DesktopCustomPreset | null): boolean {
    return preset?.keyRequired ?? false
}

export function parseWindow(value: string): number | null | undefined {
    const trimmed = value.trim().replace(/[\s_,]/g, '')
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < 256 || parsed > 10_000_000) return undefined
    return parsed
}

export function probeProblemMessage(problem: CustomProviderProbe['problem'], baseUrl: string, model?: string | null): string | null {
    switch (problem) {
        case null:
        case 'stale_revision':
        case 'cancelled':
            return null
        case 'unreachable':
            return `Could not reach ${hostOf(baseUrl)}. Check the server is running and reachable from the engine.`
        case 'unauthorized':
            return 'The server turned this key down. Check it was copied in full.'
        case 'not_listed':
            return NOT_LISTED_MESSAGE
        case 'model_refused':
            return `The server refused ${model ?? 'this model'}.`
        case 'policy_refused':
            return 'Custom endpoint policy refused.'
        case 'unavailable':
            return UNAVAILABLE_MESSAGE
        case 'invalid':
            return 'Check the address and try again.'
    }
}

/** Review is the URL the user submits. A preset id does not grant HTTP or private access. */
export function policyFor(baseUrl: string): CustomProviderConfig['policy'] {
    const url = new URL(normalizeBase(baseUrl))
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    const literalIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
    return { reviewedOrigin: url.origin, allowHttp: url.protocol === 'http:', allowPrivate: loopback || literalIp }
}

export function connectReady(input: { name: string; baseUrl: string; keyRequired: boolean; secretSaved: boolean; apiKey: string; asksModel: boolean; modelId: string }): boolean {
    const name = input.name.trim()
    if (!name || name.length > 60 || !endpointReady(input.baseUrl)) return false
    if (input.keyRequired && !input.secretSaved && !input.apiKey.trim()) return false
    if (input.asksModel && (!input.modelId.trim() || input.modelId.trim().length > 256)) return false
    return true
}

export function buildCustomProviderConfig(input: { name: string; baseUrl: string; models: CustomProviderModel[]; contextText: string; vision: boolean }): CustomProviderConfig {
    if (!endpointReady(input.baseUrl)) throw new Error('Check the address and try again.')
    const contextWindow = parseWindow(input.contextText)
    if (contextWindow === undefined) throw new Error('Check the address and try again.')
    const baseUrl = normalizeBase(input.baseUrl)
    const preset = presetForUrl(baseUrl)
    return customProviderConfigSchema.parse({
        name: input.name.trim(),
        baseUrl,
        preset: preset?.id ?? null,
        models: input.models,
        contextWindow,
        vision: input.vision,
        policy: policyFor(baseUrl),
    })
}

export function defaultContextPlaceholder(): string {
    return CUSTOM_DEFAULT_CONTEXT_WINDOW.toLocaleString('en-US')
}
