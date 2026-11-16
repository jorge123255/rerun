import 'server-only'
import { EngineRequestError, getAgent, patchAgent, setModelEffort } from '@/lib/engine/client'
import { DESKTOP_PRESET_CONNECTION_ID, connectionReasoningOptions, desktopPresetFallbackNote, desktopPresetTier, desktopPresetUnavailable, resolveDesktopPreset, type ConnectionSummary, type DesktopPresetTier } from '@rerun/contracts'
import { desktopPlanOutOfPreset, gateDesktopPick, readDesktopBackupModel, type DesktopUsageGated } from './usage-gate-model'
import type { Client } from '@libsql/client'
import { buildDesktopModelView, concreteDesktopPick, customReasoningUnavailable, desktopConnectionModelLabel, desktopConnections, offeredModelIds, usableConnection, type DesktopModelPick, type DesktopModelSource, type DesktopModelView } from '../chat-model'
import { DesktopHttpError } from './auth'
import { disabledCoworkerMessage } from './coworker-enabled'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { desktopModel, engineOf, readDesktopProviders, readDesktopWorkspacePreset } from './settings'
import { findDesktopAgent, findDesktopSession, setDesktopSessionModel, type DesktopAgent, type DesktopSession } from './store'

export async function assertDesktopImageModel(runtime: DesktopRuntime, connectionId: string | undefined) {
    const { connections } = await readDesktopProviders(runtime)
    if (connections.find(connection => connection.id === connectionId)?.provider !== 'codex')
        throw new DesktopHttpError(400, 'Image attachments need a ChatGPT / Codex model. Choose one before sending.')
}

const WORKSPACE_REQUIRED = 'Connect a provider and choose a default model in Settings.'

export function savedChoice(session: DesktopSession | null): DesktopModelPick | null {
    return session?.modelConnectionId && session.model ? { connectionId: session.modelConnectionId, model: session.model } : null
}

async function agentOrThrow(runtime: DesktopRuntime, agentId: string): Promise<DesktopAgent> {
    const agent = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    return agent
}

async function sessionFor(runtime: DesktopRuntime, agent: DesktopAgent, sessionId: string): Promise<DesktopSession> {
    const session = await findDesktopSession(await openDesktopDatabase(runtime.dataRoot), sessionId)
    if (!session || session.agentId !== agent.id) throw new DesktopHttpError(404, 'Conversation not found')
    return session
}

async function engineCoworker(runtime: DesktopRuntime, agent: DesktopAgent) {
    try {
        const detail = await getAgent(engineOf(runtime), agent.engineAgentId)
        return { connectionId: detail.config.connectionId, provider: detail.config.provider, model: detail.config.model, enabled: detail.config.enabled }
    } catch (error) {
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
        throw new DesktopHttpError(502, 'Could not read this coworker’s model. Try again.')
    }
}

async function coworkerPreset(db: Client, agentId: string): Promise<DesktopPresetTier | null> {
    const row = (await db.execute({ sql: 'SELECT tier FROM desktop_coworker_model_presets WHERE agent_id=?', args: [agentId] })).rows[0]
    return desktopPresetTier(row ? { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: String(row.tier) } : null)
}

/** A preset stands for one of the owner's own plans; this is the real pair it means right now. */
function concrete(connections: ConnectionSummary[], pick: DesktopModelPick, status: 400 | 409): DesktopModelPick {
    const tier = desktopPresetTier(pick)
    if (!tier) return pick
    const usable = desktopConnections(connections)
    const found = concreteDesktopPick(usable, pick)
    if (!found) throw new PresetUnavailable(status, desktopPresetUnavailable(tier, usable), tier)
    return found
}

function offered(connections: ConnectionSummary[], choice: DesktopModelPick): ConnectionSummary {
    const pick = concrete(connections, choice, 400)
    const connection = usableConnection(connections, pick)
    if (!connection) throw new DesktopHttpError(400, 'Choose a model offered by a connected provider.')
    return connections.find(item => item.id === connection.id)!
}

export async function readDesktopModelState(runtime: DesktopRuntime, agentId: string, sessionId?: string, options: { presets?: boolean } = {}): Promise<DesktopModelView> {
    const agent = await agentOrThrow(runtime, agentId)
    const session = sessionId ? await sessionFor(runtime, agent, sessionId) : null
    const [{ connections, default: workspace, efforts }, coworker] = await Promise.all([
        readDesktopProviders(runtime),
        engineCoworker(runtime, agent),
    ])
    const preset = options.presets ? await coworkerPreset(await openDesktopDatabase(runtime.dataRoot), agent.id) : null
    // When the workspace default is a preset, the picker's Workspace default row shows what it runs on now.
    const defaultTier = await readDesktopWorkspacePreset(runtime).catch(() => null)
    const defaultNow = defaultTier ? concreteDesktopPick(desktopConnections(connections), { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: defaultTier }) : null
    return buildDesktopModelView({ connections, workspace: defaultNow ?? workspace, coworker, conversation: savedChoice(session), efforts, presets: options.presets, coworkerPreset: preset })
}

export async function setDesktopCoworkerModel(runtime: DesktopRuntime, agentId: string, pick: DesktopModelPick | null, sessionId?: string): Promise<DesktopModelView> {
    const agent = await agentOrThrow(runtime, agentId)
    const session = sessionId ? await sessionFor(runtime, agent, sessionId) : null
    const { connections } = await readDesktopProviders(runtime)
    const db = await openDesktopDatabase(runtime.dataRoot)
    const tier = desktopPresetTier(pick)
    if (pick && tier) {
        // The engine keeps its own default for this coworker. A routine asks for the preset when it starts.
        offered(connections, pick)
        await db.execute({ sql: 'INSERT INTO desktop_coworker_model_presets(agent_id,tier) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET tier=excluded.tier', args: [agent.id, tier] })
        return readDesktopModelState(runtime, agentId, sessionId, { presets: true })
    }
    await db.execute({ sql: 'DELETE FROM desktop_coworker_model_presets WHERE agent_id=?', args: [agent.id] })
    const connection = pick ? offered(connections, pick) : null
    const patch = connection
        ? { connectionId: connection.id, provider: connection.provider, model: pick!.model }
        : { connectionId: null, provider: null, model: null }
    try {
        await patchAgent(engineOf(runtime), agent.engineAgentId, patch)
    } catch (error) {
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
        throw new DesktopHttpError(502, 'Could not save this coworker’s model. Try again.')
    }
    // Following the workspace is a statement about the coworker. It also drops the open chat's
    // override so the next message does not keep the model the user just left. Other chats stay.
    if (!pick && session) await setDesktopSessionModel(db, session.id, null)
    return readDesktopModelState(runtime, agentId, sessionId, { presets: true })
}

export async function setDesktopConversationModel(runtime: DesktopRuntime, agentId: string, sessionId: string, pick: DesktopModelPick | null): Promise<DesktopModelView> {
    const agent = await agentOrThrow(runtime, agentId)
    const session = await sessionFor(runtime, agent, sessionId)
    if (pick) offered((await readDesktopProviders(runtime)).connections, pick)
    await setDesktopSessionModel(await openDesktopDatabase(runtime.dataRoot), session.id, pick)
    return readDesktopModelState(runtime, agentId, sessionId, { presets: true })
}

/** What to tell the person when the preset behind this send is not on its first choice. */
function fallbackNote(connections: ConnectionSummary[], tier: DesktopPresetTier | null): string | undefined {
    if (!tier) return
    const usable = desktopConnections(connections)
    const found = resolveDesktopPreset(tier, usable)
    return desktopPresetFallbackNote(found, found ? desktopConnectionModelLabel(usable.find(item => item.id === found.connectionId), found.model) : '') ?? undefined
}

type ResolvedChatModel = { connectionId: string; model: string; source: DesktopModelSource; presetNote?: string; viaBackup?: true }

/**
 * `usageGate` is set by a chat send. A plan that is certain to refuse the message (a full window
 * whose reset is still ahead) is not tried: the owner's backup model answers when one may, and
 * otherwise the send is refused with the reset time, so the chat can offer to send it then.
 */
export async function resolveDesktopChatModel(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession | null, requested?: DesktopModelPick, options: { usageGate?: boolean } = {}): Promise<ResolvedChatModel> {
    if (!options.usageGate) return chatModel(runtime, agent, session, requested)
    const backup = await readDesktopBackupModel(runtime).catch(() => null)
    const gated = (found: Omit<ResolvedChatModel, 'viaBackup'>, connections: ConnectionSummary[], out = false): ResolvedChatModel => {
        const result: DesktopUsageGated = gateDesktopPick(desktopConnections(connections), found, backup, new Date(), out)
        return result.note ? { ...found, connectionId: result.connectionId, model: result.model, presetNote: result.note, viaBackup: true } : found
    }
    try {
        const found = await chatModel(runtime, agent, session, requested)
        return gated(found, (await readDesktopProviders(runtime)).connections)
    } catch (error) {
        // A preset with no plan left says which plan it is waiting for, so it can be gated the same way.
        if (!(error instanceof PresetUnavailable)) throw error
        const connections = desktopConnections((await readDesktopProviders(runtime)).connections)
        const out = desktopPlanOutOfPreset(error.tier, connections)
        if (!out) throw error
        return gated({ connectionId: out.id, model: '', source: error.source }, connections, true)
    }
}

export class PresetUnavailable extends DesktopHttpError {
    source: DesktopModelSource = 'conversation'
    constructor(status: number, message: string, readonly tier: DesktopPresetTier) { super(status, message) }
}

async function chatModel(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession | null, requested?: DesktopModelPick): Promise<{ connectionId: string; model: string; source: DesktopModelSource; presetNote?: string }> {
    // A missing workspace default still blocks chat, as it does today. A valid pin or chat
    // override then replaces it for this send without writing the workspace choice back.
    const workspace = await desktopModel(runtime)
    const { connections } = workspace
    const select = (pick: DesktopModelPick, source: DesktopModelSource) => {
        if (customReasoningUnavailable(usableConnection(connections, pick), pick.model, workspace.default))
            throw new DesktopHttpError(409, 'The saved reasoning effort needs review. Choose an available effort or Model default in Settings.')
        return { ...pick, source }
    }
    const noted = <T extends object>(result: T, tier: DesktopPresetTier | null) => { const presetNote = fallbackNote(connections, tier); return presetNote ? { ...result, presetNote } : result }
    // Check the canonical config even for a conversation override. A lost disable reply must
    // not create a first-turn reservation or an alternate-chat intent in the UI database.
    const coworker = await engineCoworker(runtime, agent)
    if (!coworker.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
    const chosen = requested ?? savedChoice(session)
    if (chosen) {
        // A preset is turned into the plan that can answer now; the engine is given that real pair.
        const conversation = concrete(connections, chosen, requested ? 400 : 409)
        if (requested) offered(connections, conversation)
        else if (!usableConnection(connections, conversation)) throw new DesktopHttpError(409, 'This conversation’s model is no longer available. Choose another model or follow the coworker default.')
        return noted(select(conversation, 'conversation'), desktopPresetTier(chosen))
    }
    const preset = await coworkerPreset(await openDesktopDatabase(runtime.dataRoot), agent.id)
    if (preset) {
        try { return noted(select(concrete(connections, { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: preset }, 409), 'coworker'), preset) }
        catch (error) { if (error instanceof PresetUnavailable) error.source = 'coworker'; throw error }
    }
    if (coworker.model) {
        const pick = coworker.connectionId ? { connectionId: coworker.connectionId, model: coworker.model } : null
        if (!usableConnection(connections, pick)) throw new DesktopHttpError(409, 'This coworker’s default model is no longer available. Choose another model or follow the workspace default.')
        return select(pick!, 'coworker')
    }
    if (!offeredModelIds(workspace.connection).includes(workspace.model)) throw new DesktopHttpError(400, WORKSPACE_REQUIRED)
    return noted(select({ connectionId: workspace.connection.id, model: workspace.model }, 'workspace'), 'preset' in workspace ? workspace.preset ?? null : null)
}

/**
 * What a routine of this coworker runs on when a Rerun preset decides it. Null means no preset
 * applies and the engine's own choice stands. The order is the chat's: the coworker's preset, then
 * a model saved on the coworker, then a preset chosen as the workspace default.
 *
 * A coworker's own preset with no plan left is refused, as it is in chat, so a routine never moves
 * to a paid key without the owner choosing that. A workspace preset with no plan left gives way to
 * the saved default model, as it does in chat.
 */
export async function resolveDesktopRoutinePreset(runtime: DesktopRuntime, engineAgentId: string): Promise<DesktopModelPick | null> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const row = (await db.execute({ sql: 'SELECT id FROM desktop_agents WHERE workspace_id=1 AND engine_agent_id=?', args: [engineAgentId] })).rows[0]
    if (!row) return null
    const own = await coworkerPreset(db, String(row.id))
    const { connections } = await readDesktopProviders(runtime)
    if (own) return concrete(connections, { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: own }, 409)
    if ((await getAgent(engineOf(runtime), engineAgentId)).config.model) return null
    const tier = await readDesktopWorkspacePreset(runtime).catch(() => null)
    return tier ? concreteDesktopPick(desktopConnections(connections), { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: tier }) : null
}

/** One effort per model: it applies wherever that model runs, the Chief of Staff included. */
export async function setDesktopModelEffort(runtime: DesktopRuntime, change: { connectionId: string; model: string; effort: string | null }) {
    const { connections } = await readDesktopProviders(runtime)
    const connection = offered(connections, { connectionId: change.connectionId, model: change.model })
    if (connection.provider === 'custom') throw new DesktopHttpError(400, 'Choose this connection’s reasoning effort in Settings.')
    if (change.effort !== null && !connectionReasoningOptions(connection, change.model)?.supported.includes(change.effort))
        throw new DesktopHttpError(400, 'Choose a reasoning effort this model offers.')
    try {
        return await setModelEffort(engineOf(runtime), { connectionId: connection.id, model: change.model, reasoningEffort: change.effort })
    } catch (error) {
        if (error instanceof EngineRequestError && error.status < 500) throw new DesktopHttpError(error.status, error.message)
        throw new DesktopHttpError(502, 'Could not save this model’s reasoning effort. Try again.')
    }
}
