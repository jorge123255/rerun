import 'server-only'
import { EngineRequestError, getAgent, patchAgent, setModelEffort } from '@/lib/engine/client'
import { DESKTOP_PRESET_CONNECTION_ID, connectionReasoningOptions, desktopPresetTier, desktopPresetUnavailable, type ConnectionSummary, type DesktopPresetTier } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { buildDesktopModelView, concreteDesktopPick, customReasoningUnavailable, desktopConnections, offeredModelIds, usableConnection, type DesktopModelPick, type DesktopModelSource, type DesktopModelView } from '../chat-model'
import { DesktopHttpError } from './auth'
import { disabledCoworkerMessage } from './coworker-enabled'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { desktopModel, engineOf, readDesktopProviders } from './settings'
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
    if (!found) throw new DesktopHttpError(status, desktopPresetUnavailable(tier, usable))
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
    return buildDesktopModelView({ connections, workspace, coworker, conversation: savedChoice(session), efforts, presets: options.presets, coworkerPreset: preset })
}

export async function setDesktopCoworkerModel(runtime: DesktopRuntime, agentId: string, pick: DesktopModelPick | null, sessionId?: string): Promise<DesktopModelView> {
    const agent = await agentOrThrow(runtime, agentId)
    const session = sessionId ? await sessionFor(runtime, agent, sessionId) : null
    const { connections } = await readDesktopProviders(runtime)
    const db = await openDesktopDatabase(runtime.dataRoot)
    const tier = desktopPresetTier(pick)
    if (pick && tier) {
        // The engine keeps its own default for this coworker, which routines still run on.
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

export async function resolveDesktopChatModel(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession | null, requested?: DesktopModelPick): Promise<{ connectionId: string; model: string; source: DesktopModelSource }> {
    // A missing workspace default still blocks chat, as it does today. A valid pin or chat
    // override then replaces it for this send without writing the workspace choice back.
    const workspace = await desktopModel(runtime)
    const { connections } = workspace
    const select = (pick: DesktopModelPick, source: DesktopModelSource) => {
        if (customReasoningUnavailable(usableConnection(connections, pick), pick.model, workspace.default))
            throw new DesktopHttpError(409, 'The saved reasoning effort needs review. Choose an available effort or Model default in Settings.')
        return { ...pick, source }
    }
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
        return select(conversation, 'conversation')
    }
    const preset = await coworkerPreset(await openDesktopDatabase(runtime.dataRoot), agent.id)
    if (preset) return select(concrete(connections, { connectionId: DESKTOP_PRESET_CONNECTION_ID, model: preset }, 409), 'coworker')
    if (coworker.model) {
        const pick = coworker.connectionId ? { connectionId: coworker.connectionId, model: coworker.model } : null
        if (!usableConnection(connections, pick)) throw new DesktopHttpError(409, 'This coworker’s default model is no longer available. Choose another model or follow the workspace default.')
        return select(pick!, 'coworker')
    }
    if (!offeredModelIds(workspace.connection).includes(workspace.model)) throw new DesktopHttpError(400, WORKSPACE_REQUIRED)
    return select({ connectionId: workspace.connection.id, model: workspace.model }, 'workspace')
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
