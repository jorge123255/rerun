import type { streamText } from 'ai'
import { connectionReasoningOptions, isDesktopSubscriptionProvider, type Provider } from '@rerun/contracts'
import { readBoxDefault } from '../connections/default.js'
import { DESKTOP_CODEX_ID } from '../desktop/codex-runtime.js'
import { desktopApp } from '../desktop/policy.js'
import type { RunModel } from './availability.js'

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

// Every provider that can show its work is asked to show it, and the model decides when there is
// anything to show: `adaptive` on Anthropic, and on the others a summary of reasoning the model
// already produces and already bills for. `claude` and `codex` drive their CLI through
// `defaultSettings` instead, and `rerun` / `openrouter` ask for it in the request body
// (see openrouter-reasoning.ts) because the OpenAI chat wire format has no field for it.
const REASONING_OPTIONS: Partial<Record<Provider, ProviderOptions>> = {
    anthropic: { anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } },
    openai: { openai: { reasoningSummary: 'auto' } },
    google: { google: { thinkingConfig: { includeThoughts: true } } },
}

export function reasoningProviderOptions(provider: Provider): ProviderOptions | undefined {
    return REASONING_OPTIONS[provider]
}

export async function desktopCodexEffort({ provider, connection, model }: RunModel): Promise<string | undefined> {
    if (provider !== 'codex' || !desktopApp() || connection?.id !== DESKTOP_CODEX_ID) return
    const options = connection.config.codexReasoning?.[model]
    if (!options) return
    const selected = await readBoxDefault()
    if (selected?.connectionId === connection.id && selected.model === model &&
        selected.reasoningEffort && options.supported.includes(selected.reasoningEffort)) return selected.reasoningEffort
    // Native Codex carries effort across turns. Send the model's recommended value
    // explicitly so switching back to Auto also resets an already-open conversation.
    return options.default
}

export async function desktopSubscriptionEffort({ provider, connection, model }: RunModel): Promise<string | undefined> {
    if (!isDesktopSubscriptionProvider(provider) || !connection) return
    const options = connectionReasoningOptions(connection.config, model)
    if (!options) return
    const selected = await readBoxDefault()
    if (selected?.connectionId === connection.id && selected.model === model && selected.reasoningEffort &&
        options.supported.includes(selected.reasoningEffort)) return selected.reasoningEffort
    return options.default
}

export async function desktopCustomEffort({ provider, connection, model }: RunModel): Promise<string | undefined> {
    if (provider !== 'custom' || !connection?.custom) return
    const selected = await readBoxDefault()
    if (selected?.connectionId !== connection.id || selected.model !== model || !selected.reasoningEffort) return
    if (selected.customReasoningRevision !== connection.custom.revision)
        throw new Error('The provider connection changed. Choose its reasoning effort again or use Model default in Settings.')
    // The provider lease checks the latest catalog again before it sends anything.
    return selected.reasoningEffort
}

// One level deep on purpose: `openai` already carries the `promptCacheKey` that applyCaching put
// there, and a plain spread of the two objects would drop it.
export function mergeProviderOptions(base: ProviderOptions | undefined, extra: ProviderOptions | undefined): ProviderOptions | undefined {
    if (!base) return extra
    if (!extra) return base
    const merged: ProviderOptions = { ...base }
    for (const [provider, options] of Object.entries(extra)) {
        merged[provider] = { ...merged[provider], ...options }
    }
    return merged
}
