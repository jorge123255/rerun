import 'server-only'
import { EngineRequestError, getAgent, patchAgent } from '@/lib/engine/client'
import type { ConnectionSummary } from '@rerun/contracts'
import { buildDesktopModelView, offeredModelIds, usableConnection, type DesktopModelPick, type DesktopModelSource, type DesktopModelView } from '../chat-model'
import { DesktopHttpError } from './auth'
import { disabledCoworkerMessage } from './coworker-enabled'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { desktopModel, engineOf, readDesktopProviders } from './settings'
import { findDesktopAgent, findDesktopSession, setDesktopSessionModel, type DesktopAgent, type DesktopSession } from './store'

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

function offered(connections: ConnectionSummary[], pick: DesktopModelPick): ConnectionSummary {
    const connection = usableConnection(connections, pick)
    if (!connection) throw new DesktopHttpError(400, 'Choose a model offered by a connected provider.')
    return connections.find(item => item.id === connection.id)!
}

export async function readDesktopModelState(runtime: DesktopRuntime, agentId: string, sessionId?: string): Promise<DesktopModelView> {
    const agent = await agentOrThrow(runtime, agentId)
    const session = sessionId ? await sessionFor(runtime, agent, sessionId) : null
    const [{ connections, default: workspace }, coworker] = await Promise.all([
        readDesktopProviders(runtime),
        engineCoworker(runtime, agent),
    ])
    return buildDesktopModelView({ connections, workspace, coworker, conversation: savedChoice(session) })
}

export async function setDesktopCoworkerModel(runtime: DesktopRuntime, agentId: string, pick: DesktopModelPick | null, sessionId?: string): Promise<DesktopModelView> {
    const agent = await agentOrThrow(runtime, agentId)
    const session = sessionId ? await sessionFor(runtime, agent, sessionId) : null
    const { connections } = await readDesktopProviders(runtime)
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
    if (!pick && session) await setDesktopSessionModel(await openDesktopDatabase(runtime.dataRoot), session.id, null)
    return readDesktopModelState(runtime, agentId, sessionId)
}

export async function setDesktopConversationModel(runtime: DesktopRuntime, agentId: string, sessionId: string, pick: DesktopModelPick | null): Promise<DesktopModelView> {
    const agent = await agentOrThrow(runtime, agentId)
    const session = await sessionFor(runtime, agent, sessionId)
    if (pick) offered((await readDesktopProviders(runtime)).connections, pick)
    await setDesktopSessionModel(await openDesktopDatabase(runtime.dataRoot), session.id, pick)
    return readDesktopModelState(runtime, agentId, sessionId)
}

export async function resolveDesktopChatModel(runtime: DesktopRuntime, agent: DesktopAgent, session: DesktopSession | null, requested?: DesktopModelPick): Promise<{ connectionId: string; model: string; source: DesktopModelSource }> {
    // A missing workspace default still blocks chat, as it does today. A valid pin or chat
    // override then replaces it for this send without writing the workspace choice back.
    const workspace = await desktopModel(runtime)
    const { connections } = workspace
    // Check the canonical config even for a conversation override. A lost disable reply must
    // not create a first-turn reservation or an alternate-chat intent in the UI database.
    const coworker = await engineCoworker(runtime, agent)
    if (!coworker.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
    const conversation = requested ?? savedChoice(session)
    if (conversation) {
        if (requested) offered(connections, requested)
        else if (!usableConnection(connections, conversation)) throw new DesktopHttpError(409, 'This conversation’s model is no longer available. Choose another model or follow the coworker default.')
        return { ...conversation, source: 'conversation' }
    }
    if (coworker.model) {
        const pick = coworker.connectionId ? { connectionId: coworker.connectionId, model: coworker.model } : null
        if (!usableConnection(connections, pick)) throw new DesktopHttpError(409, 'This coworker’s default model is no longer available. Choose another model or follow the workspace default.')
        return { connectionId: pick!.connectionId, model: coworker.model, source: 'coworker' }
    }
    if (!offeredModelIds(workspace.connection).includes(workspace.model)) throw new DesktopHttpError(400, WORKSPACE_REQUIRED)
    return { connectionId: workspace.connection.id, model: workspace.model, source: 'workspace' }
}
