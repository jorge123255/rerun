import { DESKTOP_PRESET_CONNECTION_ID, DESKTOP_PRESET_LABELS, DESKTOP_PRESET_TIERS, desktopPresetTier, isFreeDesktopOpencodeModel, resolveDesktopPreset, type DesktopPresetTier } from '@rerun/contracts'
import { DESKTOP_OLLAMA_KINDS, PROVIDER_LABELS, connectionReasoningOptions, desktopOllamaKind, modelEffortKey, modelLabel, type BoxDefaultModel, type ConnectionSummary, type ModelEfforts, type Provider } from '@rerun/contracts'
import { z } from 'zod'
import { desktopProvider } from './settings'

// Upstream ModelSelector (a6d63a4) has three statements: a click overrides the open chat, the star
// pins one coworker, and Workspace default clears that pin. The web override lives in localStorage
// under the coworker id, so two chats cannot differ. The Mac app stores the chat override on the
// saved conversation instead. Neither a click nor a star writes the workspace default, including
// its Codex reasoning effort. Effort still comes from agents/reasoning.ts desktopCodexEffort.

export type DesktopModelPick = { connectionId: string; model: string }
export type DesktopModelSource = 'conversation' | 'coworker' | 'workspace'
export type DesktopReasoning = { effort: string; source: 'model' | 'workspace' | 'model-default' }

export const desktopModelPickSchema = z.object({
    connectionId: z.string().trim().min(1).max(256),
    model: z.string().trim().min(1).max(256),
})

const catalogModelSchema = z.object({ id: z.string(), label: z.string() })
// A custom connection that is one of the named Ollama providers; it picks the logo, nothing else.
const brandSchema = z.enum(DESKTOP_OLLAMA_KINDS).optional()
const reasoningSchema = z.object({ effort: z.string(), source: z.enum(['model', 'workspace', 'model-default']) })
export const desktopModelViewSchema = z.object({
    catalog: z.array(z.object({
        connectionId: z.string(),
        name: z.string(),
        // A connection's provider, or 'rerun' for the Fast, Balanced and Smart presets.
        provider: z.union([desktopProvider, z.literal('rerun')]),
        brand: brandSchema,
        models: z.array(catalogModelSchema),
    })),
    workspace: z.object({
        connectionId: z.string(),
        provider: desktopProvider,
        name: z.string(),
        model: z.string(),
        label: z.string(),
        reasoningEffort: z.string().optional(),
    }).nullable(),
    coworker: z.object({
        connectionId: z.string().nullable(),
        provider: z.string().nullable(),
        model: z.string(),
        label: z.string(),
        available: z.boolean(),
    }).nullable(),
    conversation: z.object({
        connectionId: z.string(),
        model: z.string(),
        label: z.string(),
        available: z.boolean(),
    }).nullable(),
    effective: z.object({
        source: z.enum(['conversation', 'coworker', 'workspace']),
        // Resolved from the same active plans as a turn; an unavailable preset has none.
        presetProvider: desktopProvider.optional(),
        connectionId: z.string().nullable(),
        provider: z.string().nullable(),
        brand: brandSchema,
        name: z.string().nullable(),
        model: z.string().nullable(),
        label: z.string(),
        available: z.boolean(),
        reasoning: reasoningSchema.optional(),
        // The efforts this model can be given from the picker. Absent when it has none to choose.
        reasoningOptions: z.array(z.string()).optional(),
        reasoningUnavailable: z.boolean().optional(),
    }),
})
export type DesktopModelView = z.infer<typeof desktopModelViewSchema>

type CatalogConnection = Pick<ConnectionSummary, 'id' | 'name' | 'provider' | 'connected' | 'models' | 'extraModels'
    | 'codexReasoning' | 'customReasoning' | 'customRevision' | 'subscriptionModels' | 'opencodeModels'> & Partial<Pick<ConnectionSummary, 'credentialRejected' | 'baseUrl'>>

export function desktopConnectionModelLabel(connection: Pick<ConnectionSummary, 'subscriptionModels' | 'opencodeModels'> | null | undefined, id: string | null) {
    const opencode = connection?.opencodeModels?.find(model => model.id === id)
    if (opencode) return opencode.label + (isFreeDesktopOpencodeModel(opencode.price) ? ' · Free' : '')
    return connection?.subscriptionModels?.find(model => model.id === id)?.label ?? modelLabel(id)
}

export function offeredModelIds(connection: { models: string[]; extraModels?: string[] }): string[] {
    return [...connection.models, ...(connection.extraModels ?? [])]
}

export function desktopConnections(connections: ConnectionSummary[]): ConnectionSummary[] {
    return connections.filter(connection => desktopProvider.safeParse(connection.provider).success
        && (connection.provider !== 'custom' || connection.customRevision !== undefined))
}

export function usableConnection(connections: CatalogConnection[], pick: DesktopModelPick | null): CatalogConnection | null {
    if (!pick) return null
    const connection = connections.find(item => item.id === pick.connectionId)
    if (!connection?.connected || ((connection.provider === 'claude' || connection.provider === 'opencode') && connection.credentialRejected) || !offeredModelIds(connection).includes(pick.model)) return null
    return connection
}

/**
 * The real connection and model behind a pick. A preset (Rerun Fast, Balanced, Smart) stands for
 * whichever of the owner's own plans can answer now; anything else is already a real pair.
 */
export function concreteDesktopPick(connections: ConnectionSummary[], pick: DesktopModelPick | null, now: Date = new Date()): DesktopModelPick | null {
    const tier = desktopPresetTier(pick)
    if (!tier) return pick
    const found = resolveDesktopPreset(tier, connections, now)
    return found ? { connectionId: found.connectionId, model: found.model } : null
}

export function customReasoningUnavailable(connection: CatalogConnection | null, model: string | null, workspace: BoxDefaultModel | null): boolean {
    if (connection?.provider !== 'custom' || workspace?.connectionId !== connection.id || workspace.model !== model || !workspace.reasoningEffort) return false
    return !connection.customRevision || workspace.customReasoningRevision !== connection.customRevision
        || !connectionReasoningOptions(connection, workspace.model)?.supported.includes(workspace.reasoningEffort)
}

export function desktopReasoningChoice(connection: CatalogConnection | null, model: string | null, workspace: BoxDefaultModel | null, efforts: ModelEfforts = {}): DesktopReasoning | undefined {
    if (!connection || !model || customReasoningUnavailable(connection, model, workspace)) return
    const options = connectionReasoningOptions(connection, model)
    if (!options) return
    // The effort chosen for this model wins wherever the model runs.
    const chosen = efforts[modelEffortKey(connection.id, model)]
    if (chosen && options.supported.includes(chosen)) return { effort: chosen, source: 'model' }
    if (workspace?.connectionId === connection.id && workspace.model === model && workspace.reasoningEffort && options.supported.includes(workspace.reasoningEffort)) {
        return { effort: workspace.reasoningEffort, source: 'workspace' }
    }
    return options.default ? { effort: options.default, source: 'model-default' } : undefined
}

function brandOf(connection: Pick<CatalogConnection, 'provider' | 'baseUrl'> | null | undefined) {
    const brand = desktopOllamaKind(connection)
    return brand ? { brand } : {}
}

function providerName(provider: string | null): string | null {
    if (!provider) return null
    return provider in PROVIDER_LABELS ? PROVIDER_LABELS[provider as Provider] : provider
}

export function buildDesktopModelView(input: {
    connections: ConnectionSummary[]
    workspace: BoxDefaultModel | null
    coworker: { connectionId: string | null; provider: string | null; model: string | null } | null
    conversation: DesktopModelPick | null
    efforts?: ModelEfforts
    /** Offer the Rerun presets and read preset picks. Off where a pick must be a real pair. */
    presets?: boolean
    /** This coworker's default when it is a preset; it is kept by the app, not by the engine. */
    coworkerPreset?: DesktopPresetTier | null
    now?: Date
}): DesktopModelView {
    const connections = desktopConnections(input.connections)
    const now = input.now ?? new Date()
    const real = (pick: DesktopModelPick | null) => desktopPresetTier(pick) ? (input.presets ? concreteDesktopPick(connections, pick, now) : null) : pick
    const presetLabel = (pick: DesktopModelPick | null) => {
        const tier = desktopPresetTier(pick)
        if (!tier) return null
        const found = input.presets ? resolveDesktopPreset(tier, connections, now) : null
        const via = found ? desktopConnectionModelLabel(connections.find(item => item.id === found.connectionId), found.model) : null
        return via ? `${DESKTOP_PRESET_LABELS[tier]} · ${via}` : DESKTOP_PRESET_LABELS[tier]
    }
    const workspaceConnection = usableConnection(connections, input.workspace)
    const workspace = input.workspace && workspaceConnection ? {
        connectionId: workspaceConnection.id,
        provider: desktopProvider.parse(workspaceConnection.provider),
        name: workspaceConnection.name,
        model: input.workspace.model,
        label: desktopConnectionModelLabel(workspaceConnection, input.workspace.model),
        ...(input.workspace.reasoningEffort ? { reasoningEffort: input.workspace.reasoningEffort } : {}),
    } : null
    const presetPin = input.presets && input.coworkerPreset ? { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: input.coworkerPreset } : null
    const pinned = presetPin ?? (input.coworker?.model ? { connectionId: input.coworker.connectionId ?? '', model: input.coworker.model } : null)
    const pinnedConnection = !presetPin && input.coworker?.connectionId ? connections.find(item => item.id === input.coworker?.connectionId) ?? null : null
    const coworker = presetPin ? {
        connectionId: presetPin.connectionId, provider: 'rerun', model: presetPin.model, label: presetLabel(presetPin)!, available: !!usableConnection(connections, real(presetPin)),
    } : pinned ? {
        connectionId: input.coworker?.connectionId ?? null,
        provider: pinnedConnection?.provider ?? input.coworker?.provider ?? null,
        model: pinned.model,
        label: desktopConnectionModelLabel(pinnedConnection, pinned.model),
        available: !!usableConnection(connections, input.coworker?.connectionId ? { connectionId: input.coworker.connectionId, model: pinned.model } : null),
    } : null
    const conversation = input.conversation ? {
        connectionId: input.conversation.connectionId,
        model: input.conversation.model,
        label: presetLabel(input.conversation) ?? desktopConnectionModelLabel(usableConnection(connections, input.conversation), input.conversation.model),
        available: !!usableConnection(connections, real(input.conversation)),
    } : null
    const source: DesktopModelSource = conversation ? 'conversation' : coworker ? 'coworker' : 'workspace'
    const selected = input.conversation ?? pinned ?? input.workspace
    // A preset shows as itself in the picker; what it runs on today is in its label.
    const preset = desktopPresetTier(selected)
    const selectedReal = real(selected)
    const selectedConnection = usableConnection(connections, selectedReal) ?? (selected && !preset ? connections.find(item => item.id === selected.connectionId) ?? null : null)
    const model = selected?.model ?? null
    const available = !!usableConnection(connections, selectedReal)
    const reasoning = preset ? undefined : desktopReasoningChoice(available ? selectedConnection : null, model, input.workspace, input.efforts)
    // A custom endpoint's efforts follow a revision of its catalog and stay in Settings.
    const reasoningOptions = !preset && available && selectedConnection && model && selectedConnection.provider !== 'custom'
        ? connectionReasoningOptions(selectedConnection, model)?.supported : undefined
    const reasoningUnavailable = !preset && available && customReasoningUnavailable(selectedConnection, model, input.workspace)
    const presetGroup = input.presets ? DESKTOP_PRESET_TIERS.flatMap(tier => {
        const label = resolveDesktopPreset(tier, connections, now) && presetLabel({ connectionId: DESKTOP_PRESET_CONNECTION_ID, model: tier })
        return label ? [{ id: tier, label }] : []
    }) : []
    return desktopModelViewSchema.parse({
        catalog: [...(presetGroup.length ? [{ connectionId: DESKTOP_PRESET_CONNECTION_ID, name: 'Rerun', provider: 'rerun' as const, models: presetGroup }] : []), ...connections.filter(item => item.connected && offeredModelIds(item).length > 0).map(item => ({
            connectionId: item.id,
            name: item.name,
            provider: desktopProvider.parse(item.provider),
            ...brandOf(item),
            models: offeredModelIds(item).map(id => ({ id, label: desktopConnectionModelLabel(item, id) })),
        }))],
        workspace,
        coworker,
        conversation,
        effective: {
            source,
            connectionId: preset ? DESKTOP_PRESET_CONNECTION_ID : selectedConnection?.id ?? (selected?.connectionId || null),
            provider: preset ? 'rerun' : selectedConnection?.provider ?? coworker?.provider ?? null,
            ...(preset && available && selectedConnection && { presetProvider: selectedConnection.provider }),
            ...(!preset && brandOf(selectedConnection)),
            name: preset ? 'Rerun' : selectedConnection?.name ?? providerName(selectedConnection?.provider ?? coworker?.provider ?? null),
            model,
            label: presetLabel(selected) ?? desktopConnectionModelLabel(selectedConnection, model),
            available,
            ...(reasoning ? { reasoning } : {}),
            ...(reasoningOptions?.length ? { reasoningOptions } : {}),
            ...(reasoningUnavailable && { reasoningUnavailable }),
        },
    })
}
