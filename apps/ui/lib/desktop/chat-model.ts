import { PROVIDER_LABELS, modelLabel, type BoxDefaultModel, type ConnectionSummary, type Provider } from '@rerun/contracts'
import { z } from 'zod'
import { desktopProvider } from './settings'

// Upstream ModelSelector (a6d63a4) has three statements: a click overrides the open chat, the star
// pins one coworker, and Workspace default clears that pin. The web override lives in localStorage
// under the coworker id, so two chats cannot differ. The Mac app stores the chat override on the
// saved conversation instead. Neither a click nor a star writes the workspace default, including
// its Codex reasoning effort. Effort still comes from agents/reasoning.ts desktopCodexEffort.

export type DesktopModelPick = { connectionId: string; model: string }
export type DesktopModelSource = 'conversation' | 'coworker' | 'workspace'
export type DesktopReasoning = { effort: string; source: 'workspace' | 'model-default' }

export const desktopModelPickSchema = z.object({
    connectionId: z.string().trim().min(1).max(256),
    model: z.string().trim().min(1).max(256),
})

const catalogModelSchema = z.object({ id: z.string(), label: z.string() })
const reasoningSchema = z.object({ effort: z.string(), source: z.enum(['workspace', 'model-default']) })
export const desktopModelViewSchema = z.object({
    catalog: z.array(z.object({
        connectionId: z.string(),
        name: z.string(),
        provider: desktopProvider,
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
        connectionId: z.string().nullable(),
        provider: z.string().nullable(),
        name: z.string().nullable(),
        model: z.string().nullable(),
        label: z.string(),
        available: z.boolean(),
        reasoning: reasoningSchema.optional(),
    }),
})
export type DesktopModelView = z.infer<typeof desktopModelViewSchema>

export const MODEL_SOURCE_LABEL: Record<DesktopModelSource, string> = {
    conversation: 'This chat',
    coworker: 'Coworker default',
    workspace: 'Workspace default',
}

type CatalogConnection = Pick<ConnectionSummary, 'id' | 'name' | 'provider' | 'connected' | 'models' | 'extraModels' | 'codexReasoning'> & Partial<Pick<ConnectionSummary, 'credentialRejected'>>

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
    if (!connection?.connected || (connection.provider === 'claude' && connection.credentialRejected) || !offeredModelIds(connection).includes(pick.model)) return null
    return connection
}

// The same choice desktopCodexEffort makes at run time: the saved workspace effort when this
// Codex model is the workspace model, otherwise that model's own recommended effort.
export function desktopReasoningChoice(connection: CatalogConnection | null, model: string | null, workspace: BoxDefaultModel | null): DesktopReasoning | undefined {
    if (connection?.provider !== 'codex' || !model) return
    const options = connection.codexReasoning?.[model]
    if (!options) return
    if (workspace?.connectionId === connection.id && workspace.model === model && workspace.reasoningEffort && options.supported.includes(workspace.reasoningEffort)) {
        return { effort: workspace.reasoningEffort, source: 'workspace' }
    }
    return options.default ? { effort: options.default, source: 'model-default' } : undefined
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
}): DesktopModelView {
    const connections = desktopConnections(input.connections)
    const workspaceConnection = usableConnection(connections, input.workspace)
    const workspace = input.workspace && workspaceConnection ? {
        connectionId: workspaceConnection.id,
        provider: desktopProvider.parse(workspaceConnection.provider),
        name: workspaceConnection.name,
        model: input.workspace.model,
        label: modelLabel(input.workspace.model),
        ...(input.workspace.reasoningEffort ? { reasoningEffort: input.workspace.reasoningEffort } : {}),
    } : null
    const pinned = input.coworker?.model ? { connectionId: input.coworker.connectionId ?? '', model: input.coworker.model } : null
    const pinnedConnection = input.coworker?.connectionId ? connections.find(item => item.id === input.coworker?.connectionId) ?? null : null
    const coworker = pinned ? {
        connectionId: input.coworker?.connectionId ?? null,
        provider: pinnedConnection?.provider ?? input.coworker?.provider ?? null,
        model: pinned.model,
        label: modelLabel(pinned.model),
        available: !!usableConnection(connections, input.coworker?.connectionId ? { connectionId: input.coworker.connectionId, model: pinned.model } : null),
    } : null
    const conversation = input.conversation ? {
        connectionId: input.conversation.connectionId,
        model: input.conversation.model,
        label: modelLabel(input.conversation.model),
        available: !!usableConnection(connections, input.conversation),
    } : null
    const source: DesktopModelSource = conversation ? 'conversation' : coworker ? 'coworker' : 'workspace'
    const selected = source === 'conversation' ? input.conversation : source === 'coworker' && input.coworker?.connectionId ? { connectionId: input.coworker.connectionId, model: coworker!.model } : input.workspace
    const selectedConnection = usableConnection(connections, selected) ?? (selected ? connections.find(item => item.id === selected.connectionId) ?? null : null)
    const model = selected?.model ?? null
    const available = !!usableConnection(connections, selected)
    const reasoning = desktopReasoningChoice(available ? selectedConnection : null, model, input.workspace)
    return desktopModelViewSchema.parse({
        catalog: connections.filter(item => item.connected && offeredModelIds(item).length > 0).map(item => ({
            connectionId: item.id,
            name: item.name,
            provider: desktopProvider.parse(item.provider),
            models: offeredModelIds(item).map(id => ({ id, label: modelLabel(id) })),
        })),
        workspace,
        coworker,
        conversation,
        effective: {
            source,
            connectionId: selectedConnection?.id ?? selected?.connectionId ?? null,
            provider: selectedConnection?.provider ?? coworker?.provider ?? null,
            name: selectedConnection?.name ?? providerName(selectedConnection?.provider ?? coworker?.provider ?? null),
            model,
            label: modelLabel(model),
            available,
            ...(reasoning ? { reasoning } : {}),
        },
    })
}
