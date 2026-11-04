import 'server-only'
import { desktopRerunGrantsOf } from '@rerun/contracts'
import { EngineRequestError, chat, createAgent, getAgent, getSessionMessages, patchAgent } from '@/lib/engine/client'
import type { DesktopCoworkerPatch, DesktopCoworkerSettings } from '../coworker-settings'
import { publicDesktopHistory, transformEngineMessages, type HistoryMessage } from '@/lib/chat/engine-history'
import { sanitizeIdentifier } from '@/lib/utils'
import { resolveDesktopChatModel, savedChoice } from './chat-model'
import type { DesktopModelPick } from '../chat-model'
import { changeDesktopSettings, desktopModel, engineOf, readDesktopProviders } from './settings'
import { DesktopHttpError } from './auth'
import { disabledCoworkerMessage } from './coworker-enabled'
import { readCoworkerFile } from './coworker-files'
import { openDesktopDatabase } from './database'
import { discardTabStart, existingTabStart, recoverTabSession, reserveTabStart } from './tab-starts'
import type { DesktopRuntime } from './runtime'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, findDesktopSession, regenerationRequestId } from './store'

// Compatibility endpoint for the original OpenAI setup form.
export async function connectDesktopOpenAI(runtime: DesktopRuntime, apiKey: string) {
    await changeDesktopSettings(runtime, { action: 'key', provider: 'openai', apiKey })
    const { connections } = await readDesktopProviders(runtime)
    const connection = connections.find(c => c.provider === 'openai')
    if (!connection) throw new DesktopHttpError(502, 'Could not read the saved connection.')
    return { id: connection.id, provider: connection.provider, name: connection.name }
}

export async function createDesktopCoworker(runtime: DesktopRuntime, input: { name: string; description?: string }) {
    const name = input.name.trim()
    if (!name || name.length > 60) throw new DesktopHttpError(400, 'Coworker name must be between 1 and 60 characters')
    const description = input.description?.trim() ?? ''
    if (description.length > 2000) throw new DesktopHttpError(400, 'Description is too long')
    const db = await openDesktopDatabase(runtime.dataRoot)
    const { connection } = await desktopModel(runtime)
    const handle = `${sanitizeIdentifier(name).replace(/^_+|_+$/g, '') || 'coworker'}-${crypto.randomUUID().slice(0, 8)}`
    const created = await createAgent(engineOf(runtime), {
        config: {
            name: handle,
            displayName: name,
            description,
            enabled: true,
            connectionId: connection.id,
            provider: connection.provider,
            model: null,
        },
    })
    return createDesktopAgent(db, { engineAgentId: created.id, name, description })
}

export async function desktopCoworkerSettings(runtime: DesktopRuntime, id: string, patch?: DesktopCoworkerPatch): Promise<DesktopCoworkerSettings> {
    const agent = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), id)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    // This registry contains only user-created local coworkers. Cloud template agents, whose
    // system prompts can be sealed, cannot be resolved by their engine IDs through this route.
    const engine = engineOf(runtime)
    try {
        const { memoryEnabled, autoMemory, workspaceReadEnabled, ...textSettings } = patch ?? {}
        const tools = {
            ...(workspaceReadEnabled !== undefined && { desktopToolGrants: { workspaceRead: workspaceReadEnabled } }),
            ...(memoryEnabled !== undefined && { memory: memoryEnabled }),
        }
        const detail = patch ? await patchAgent(engine, agent.engineAgentId, {
            ...textSettings,
            ...(Object.keys(tools).length > 0 && { tools }),
            ...(autoMemory !== undefined && { selfImprovement: { autoMemory } }),
        }) : await getAgent(engine, agent.engineAgentId)
        return {
            soul: detail.soul, verbosity: detail.config.verbosity, soulEditable: true,
            workspaceReadEnabled: desktopRerunGrantsOf(detail.config.tools).workspaceRead,
            memoryEnabled: detail.config.tools.memory,
            autoMemory: detail.config.selfImprovement.autoMemory,
            selfImprovementEnabled: detail.config.selfImprovement.enabled,
        }
    } catch (error) {
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
        throw new DesktopHttpError(502, 'Could not reach this coworker’s settings. Try again.')
    }
}

type DesktopChatInput = { agentId: string } & (
    | { sessionId?: string; text: string; attachmentPath?: string; modelChoice?: DesktopModelPick; tabUid?: string }
    | { sessionId: string; regenerateMessageId: string; requestId: string }
)

export async function startDesktopChat(runtime: DesktopRuntime, input: DesktopChatInput): Promise<{ response: Response; sessionId: string }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const agent = await findDesktopAgent(db, input.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    if (!agent.enabled) throw new DesktopHttpError(403, disabledCoworkerMessage)
    const existing = input.sessionId ? await findDesktopSession(db, input.sessionId) : null
    if (input.sessionId && (!existing || existing.agentId !== agent.id)) throw new DesktopHttpError(404, 'Conversation not found')
    const regenerate = 'regenerateMessageId' in input
    const uid = !regenerate && !existing ? input.tabUid : undefined
    const previousStart = !regenerate && uid ? await existingTabStart(db, agent, uid, input) : null
    if (previousStart) {
        const id = await recoverTabSession(db, engineOf(runtime), agent, previousStart)
        if (id) return { sessionId: id, response: new Response('data: [DONE]\n\n', { headers: {
            'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': id, 'x-run-id': String(previousStart.run_id),
        } }) }
    }
    const file = !regenerate && input.attachmentPath !== undefined ? await readCoworkerFile(runtime, agent.id, input.attachmentPath, 'attach') : undefined
    // Existing chats resolve their own saved model. Only a first send can carry an unsaved choice.
    const firstChoice = !regenerate && !existing ? input.modelChoice : undefined
    const { connectionId, model } = await resolveDesktopChatModel(runtime, agent, existing, firstChoice)
    const requestId = regenerate ? await regenerationRequestId(db, input.sessionId, input.regenerateMessageId, input.requestId) : undefined
    const start = !regenerate && uid ? previousStart ?? await reserveTabStart(db, agent, uid, input, runtime.launchNonce) : null
    const engineResponse = await chat(engineOf(runtime), agent.engineAgentId, {
        ...(regenerate ? {
            sessionId: existing!.engineSessionId,
            regenerateMessageId: input.regenerateMessageId.slice('engine-'.length),
            requestId: requestId!,
        } : {
            sessionId: existing?.engineSessionId, message: input.text,
            ...(start && { desktopFirstTurn: { sessionId: String(start.engine_session_id), runId: String(start.run_id) } }),
            workspaceAttachment: file && { path: file.path, content: file.content },
        }),
        connectionId,
        model,
        source: 'dashboard',
        author: { id: 'local-profile-1', name: 'Local User' },
    })
    if (regenerate && !engineResponse.ok) {
        if (engineResponse.status === 404) throw new DesktopHttpError(404, 'This reply is no longer in the selected conversation.')
        if (engineResponse.status === 409) throw new DesktopHttpError(409, 'This reply could not be regenerated. Check that the conversation is idle and the reply is complete.')
    }
    if (start && engineResponse.status >= 400 && engineResponse.status < 500) {
        if (!await recoverTabSession(db, engineOf(runtime), agent, start)) await discardTabStart(db, start)
        if (engineResponse.status === 403) throw new DesktopHttpError(403, disabledCoworkerMessage)
        throw new DesktopHttpError(engineResponse.status, 'The engine could not start this first message. Check the coworker or model, then try again.')
    }
    if (engineResponse.status === 403) throw new DesktopHttpError(403, disabledCoworkerMessage)
    // A replay can recover the alternate even after the engine's stream has expired.
    const completedReplay = (regenerate || !!start) && engineResponse.status === 204
    if (!engineResponse.ok || (!engineResponse.body && !completedReplay)) throw new DesktopHttpError(502, 'The engine could not start this conversation')
    const engineSessionId = engineResponse.headers.get('x-session-id')
    if (!engineSessionId) throw new DesktopHttpError(502, 'The engine did not return a conversation ID')
    if (start && (engineSessionId !== start.engine_session_id || engineResponse.headers.get('x-run-id') !== start.run_id)) throw new DesktopHttpError(502, 'The engine returned a different first turn.')
    if (regenerate && engineSessionId === existing!.engineSessionId) throw new DesktopHttpError(502, 'The engine did not return an alternate conversation.')
    const session = regenerate
        ? await createDesktopSession(db, { agentId: agent.id, engineSessionId, title: 'Alternate · ' + existing!.title.replace(/^Alternate · /, ''), regenerationRequestId: requestId, model: savedChoice(existing) })
        : existing ?? await createDesktopSession(db, { agentId: agent.id, engineSessionId, title: input.text.trim(), model: firstChoice })
    const headers = new Headers({
        'content-type': engineResponse.headers.get('content-type') ?? 'text/event-stream',
        'x-vercel-ai-ui-message-stream': engineResponse.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1',
        'x-session-id': session.id,
    })
    const runId = engineResponse.headers.get('x-run-id')
    if (runId) headers.set('x-run-id', runId)
    return { response: new Response(completedReplay ? 'data: [DONE]\n\n' : engineResponse.body, { status: 200, headers }), sessionId: session.id }
}

export async function readDesktopHistory(runtime: DesktopRuntime, sessionId: string): Promise<HistoryMessage[]> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    try {
        const messages = await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId, { requireSuccess: true })
        const history = transformEngineMessages(messages, { desktopSummaries: true, preserveSourceSteps: true })
        // Only a read of this specific alternate acknowledges it. Opening the original, or an
        // older alternate while a newer request is pending, leaves the pending attempt alone.
        await db.execute({ sql: 'UPDATE desktop_regeneration_requests SET pending = 0 WHERE alternate_session_id = ? AND pending = 1', args: [session.id] })
        return publicDesktopHistory(history)
    } catch (cause) {
        if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        throw new DesktopHttpError(502, 'Could not load this conversation. Try again.')
    }
}
