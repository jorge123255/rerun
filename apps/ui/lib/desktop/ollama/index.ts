import {
    DESKTOP_OLLAMA, desktopOllamaConfig, desktopOllamaPolicy,
    type CustomProviderIdentity, type CustomProviderModel, type CustomProviderProbe, type DesktopOllamaKind,
} from '@rerun/contracts'
import type { DesktopCustomProviderClient } from '../custom-providers/client'

/**
 * Ollama (this Mac) and Ollama Cloud in Settings. Both ride the custom-endpoint route, so the engine
 * keeps the key, the revisions and the network path; nothing here reads a key back.
 */
export type OllamaAdapter = Pick<DesktopCustomProviderClient, 'read' | 'probe' | 'probeDraft' | 'change'>
export type OllamaConnectionRef = { id: string; revision: number }
export type OllamaState = 'ready' | 'not-running' | 'empty' | 'key-rejected' | 'unreachable' | 'unavailable'
export type OllamaView = {
    state: OllamaState
    /** Models offered to coworkers and chats. */
    models: CustomProviderModel[]
    /** Listed by Ollama but left out because Ollama says they cannot call tools. */
    withoutTools: string[]
    /** False when this Ollama does not report what its models can do. */
    toolsKnown: boolean
    /** The saved connection changed; the caller reloads the connection list. */
    changed: boolean
}

export const OLLAMA_NOT_RUNNING = 'Ollama is not running on this Mac.'
export const OLLAMA_NO_MODELS = 'Ollama is running but has no chat models yet. Download one in the Ollama app or with "ollama pull".'
export const OLLAMA_KEY_REJECTED = 'Ollama turned this key down. Check it was copied in full.'
export const OLLAMA_CLOUD_UNREACHABLE = 'Could not reach ollama.com. Check the internet connection and try again.'
export const OLLAMA_UNAVAILABLE = 'Ollama settings are unavailable right now. Try again.'
export const ollamaKeyWarning = (model: string) => `Key saved, but Ollama refused a test request to ${model} with it. If chats fail, check the key and that your Ollama plan includes cloud models.`
export const OLLAMA_DEFAULT_LOCK = 'This is the workspace default. Choose another default model first.'

export function ollamaMessage(kind: DesktopOllamaKind, state: OllamaState): string | null {
    switch (state) {
        case 'ready': return null
        case 'not-running': return OLLAMA_NOT_RUNNING
        case 'empty': return kind === 'ollama' ? OLLAMA_NO_MODELS : 'Ollama Cloud listed no chat models.'
        case 'key-rejected': return OLLAMA_KEY_REJECTED
        case 'unreachable': return OLLAMA_CLOUD_UNREACHABLE
        case 'unavailable': return OLLAMA_UNAVAILABLE
    }
}

/**
 * What to offer from Ollama's list. A model Ollama marks as unable to call tools is left out,
 * because every coworker turn carries tools; it is named so the owner can see why. The workspace
 * default is never dropped from under the owner.
 */
export function ollamaModelPlan(listed: CustomProviderModel[], enabled: CustomProviderModel[], defaultModelId: string | null) {
    const models = listed.filter(model => model.tools !== false).slice(0, 256)
    if (defaultModelId && !models.some(model => model.id === defaultModelId)) {
        const keep = listed.find(model => model.id === defaultModelId) ?? enabled.find(model => model.id === defaultModelId)
        if (keep) models.splice(255, 1, keep)
    }
    return {
        models,
        withoutTools: listed.filter(model => model.tools === false && !models.some(kept => kept.id === model.id)).map(model => model.id),
        toolsKnown: listed.length === 0 || listed.some(model => model.tools !== undefined),
    }
}

export function sameOllamaModels(a: CustomProviderModel[], b: CustomProviderModel[]): boolean {
    const key = (model: CustomProviderModel) => JSON.stringify([model.id, model.contextWindow, model.vision, model.tools ?? null])
    const left = a.map(key).sort(), right = b.map(key).sort()
    return left.length === right.length && left.every((value, index) => value === right[index])
}

function stateOf(kind: DesktopOllamaKind, probe: Pick<CustomProviderProbe, 'status' | 'problem'>, usable: number): OllamaState {
    if (probe.problem === 'unauthorized') return 'key-rejected'
    if (probe.problem === 'unreachable') return kind === 'ollama' ? 'not-running' : 'unreachable'
    if (probe.status === 'unavailable') return 'unavailable'
    return usable > 0 ? 'ready' : 'empty'
}

const none = (state: OllamaState): OllamaView => ({ state, models: [], withoutTools: [], toolsKnown: true, changed: false })
const identityOf = (workspaceId: number, connection: OllamaConnectionRef): CustomProviderIdentity => ({ workspaceId, connectionId: connection.id, revision: connection.revision })

/**
 * Ask Ollama what it serves now. With a saved connection, a changed list is written back so the
 * model picker follows the Ollama app; a list that did not change writes nothing (a write stops a
 * run in flight on that connection).
 */
export async function refreshOllama(input: {
    adapter: OllamaAdapter; kind: DesktopOllamaKind; workspaceId: number; connection: OllamaConnectionRef | null
    defaultModelId: string | null; signal: AbortSignal; requestId?: () => string
}): Promise<OllamaView> {
    const { adapter, kind, workspaceId, connection, signal } = input
    const id = input.requestId ?? (() => crypto.randomUUID())
    if (!connection) {
        const draft = await adapter.probeDraft({ action: 'probe_draft', requestId: id(), workspaceId, baseUrl: DESKTOP_OLLAMA[kind].baseUrl, policy: desktopOllamaPolicy(kind) }, signal)
        if (!draft.ok) return none('unavailable')
        const plan = ollamaModelPlan(draft.value.models, [], null)
        return { ...plan, state: stateOf(kind, draft.value, plan.models.length), changed: false }
    }
    const identity = identityOf(workspaceId, connection)
    const saved = await adapter.read(identity, signal)
    if (!saved.ok) return none('unavailable')
    const probe = await adapter.probe(identity, undefined, signal)
    if (!probe.ok) return none('unavailable')
    const enabled = saved.value.config.models
    if (probe.value.status !== 'fresh') {
        const state = stateOf(kind, probe.value, 0)
        // Ollama being closed does not forget what it offered: the saved models stay selectable.
        return { state, models: enabled, withoutTools: [], toolsKnown: true, changed: false }
    }
    const plan = ollamaModelPlan(probe.value.models, enabled, input.defaultModelId)
    if (!plan.models.length) return { ...plan, models: enabled, state: 'empty', changed: false }
    if (sameOllamaModels(plan.models, enabled)) return { ...plan, state: 'ready', changed: false }
    const receipt = await adapter.change({ action: 'update', requestId: id(), identity, config: desktopOllamaConfig(kind, plan.models, saved.value.config.name), clearSecret: false }, signal)
    return receipt.ok ? { ...plan, state: 'ready', changed: true } : { ...plan, models: enabled, state: 'ready', changed: false }
}

export type OllamaActionResult = { ok: true; warning?: string } | { ok: false; message: string }

/** Start using the Ollama app on this Mac. No key exists for it. */
export async function connectLocalOllama(input: { adapter: OllamaAdapter; workspaceId: number; models: CustomProviderModel[]; name: string; signal: AbortSignal; requestId?: () => string }): Promise<OllamaActionResult> {
    if (!input.models.length) return { ok: false, message: OLLAMA_NO_MODELS }
    const id = input.requestId ?? (() => crypto.randomUUID())
    const receipt = await input.adapter.change({ action: 'create', requestId: id(), workspaceId: input.workspaceId, connectionId: id(), config: desktopOllamaConfig('ollama', input.models, input.name) }, input.signal)
    return receipt.ok ? { ok: true } : { ok: false, message: OLLAMA_UNAVAILABLE }
}

/**
 * Save or replace the Ollama Cloud key. ollama.com lists its models to anyone, so the list cannot
 * prove a key; one single-token request does. A refusal there is reported but does not block the
 * save, since a plan without that model is refused the same way as a bad key. The engine encrypts
 * the key; it is sent only to ollama.com.
 */
export async function saveOllamaCloudKey(input: {
    adapter: OllamaAdapter; workspaceId: number; connection: OllamaConnectionRef | null; apiKey: string
    defaultModelId: string | null; name: string; signal: AbortSignal; requestId?: () => string
}): Promise<OllamaActionResult> {
    const { adapter, workspaceId, connection, signal } = input
    const apiKey = input.apiKey.trim()
    if (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey) || apiKey.length > 8192) return { ok: false, message: 'Enter the key exactly as Ollama shows it.' }
    const id = input.requestId ?? (() => crypto.randomUUID())
    const draft = { action: 'probe_draft' as const, workspaceId, baseUrl: DESKTOP_OLLAMA['ollama-cloud'].baseUrl, policy: desktopOllamaPolicy('ollama-cloud'), apiKey }
    const listed = await adapter.probeDraft({ ...draft, requestId: id() }, signal)
    if (!listed.ok) return { ok: false, message: OLLAMA_UNAVAILABLE }
    if (listed.value.problem === 'unauthorized') return { ok: false, message: OLLAMA_KEY_REJECTED }
    if (listed.value.status !== 'fresh') return { ok: false, message: listed.value.problem === 'unreachable' ? OLLAMA_CLOUD_UNREACHABLE : 'Ollama Cloud listed no chat models.' }
    let enabled: CustomProviderModel[] = []
    if (connection) {
        const saved = await adapter.read(identityOf(workspaceId, connection), signal)
        if (!saved.ok) return { ok: false, message: OLLAMA_UNAVAILABLE }
        enabled = saved.value.config.models
    }
    const plan = ollamaModelPlan(listed.value.models, enabled, input.defaultModelId)
    if (!plan.models.length) return { ok: false, message: 'Ollama Cloud listed no chat models.' }
    const proof = await adapter.probeDraft({ ...draft, requestId: id(), manualModel: plan.models[0]!.id }, signal)
    if (!proof.ok) return { ok: false, message: OLLAMA_UNAVAILABLE }
    const warning = proof.value.problem === 'unauthorized' ? ollamaKeyWarning(plan.models[0]!.id) : undefined
    const config = desktopOllamaConfig('ollama-cloud', plan.models, input.name)
    const receipt = connection
        ? await adapter.change({ action: 'update', requestId: id(), identity: identityOf(workspaceId, connection), config, apiKey, clearSecret: false }, signal)
        : await adapter.change({ action: 'create', requestId: id(), workspaceId, connectionId: id(), config, apiKey }, signal)
    return receipt.ok ? { ok: true, ...(warning && { warning }) } : { ok: false, message: OLLAMA_UNAVAILABLE }
}

/** Remove the provider. For Ollama Cloud this deletes the stored key with it. */
export async function removeOllama(input: { adapter: OllamaAdapter; workspaceId: number; connection: OllamaConnectionRef; isDefault: boolean; signal: AbortSignal; requestId?: () => string }): Promise<OllamaActionResult> {
    if (input.isDefault) return { ok: false, message: OLLAMA_DEFAULT_LOCK }
    const id = input.requestId ?? (() => crypto.randomUUID())
    const receipt = await input.adapter.change({ action: 'disconnect', requestId: id(), identity: identityOf(input.workspaceId, input.connection) }, input.signal)
    return receipt.ok ? { ok: true } : { ok: false, message: OLLAMA_UNAVAILABLE }
}
