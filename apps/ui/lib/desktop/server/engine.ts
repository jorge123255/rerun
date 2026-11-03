import 'server-only'
import { EngineRequestError, chat, createAgent, getAgent, getSessionMessages, patchAgent } from '@/lib/engine/client'
import type { DesktopCoworkerPatch, DesktopCoworkerSettings } from '../coworker-settings'
import { transformEngineMessages, type HistoryMessage } from '@/lib/chat/engine-history'
import { sanitizeIdentifier } from '@/lib/utils'
import { changeDesktopSettings, desktopModel, engineOf, readDesktopProviders } from './settings'
import { DesktopHttpError } from './auth'
import { readCoworkerFile } from './coworker-files'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, findDesktopSession } from './store'

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
        const { memoryEnabled, autoMemory, ...textSettings } = patch ?? {}
        const detail = patch ? await patchAgent(engine, agent.engineAgentId, {
            ...textSettings,
            ...(memoryEnabled !== undefined && { tools: { memory: memoryEnabled } }),
            ...(autoMemory !== undefined && { selfImprovement: { autoMemory } }),
        }) : await getAgent(engine, agent.engineAgentId)
        return {
            soul: detail.soul, verbosity: detail.config.verbosity, soulEditable: true,
            memoryEnabled: detail.config.tools.memory,
            autoMemory: detail.config.selfImprovement.autoMemory,
            selfImprovementEnabled: detail.config.selfImprovement.enabled,
        }
    } catch (error) {
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
        throw new DesktopHttpError(502, 'Could not reach this coworker’s settings. Try again.')
    }
}

export async function startDesktopChat(runtime: DesktopRuntime, input: { agentId: string; sessionId?: string; text: string; attachmentPath?: string }): Promise<{ response: Response; sessionId: string }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const agent = await findDesktopAgent(db, input.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    const existing = input.sessionId ? await findDesktopSession(db, input.sessionId) : null
    if (input.sessionId && (!existing || existing.agentId !== agent.id)) throw new DesktopHttpError(404, 'Conversation not found')
    const file = input.attachmentPath === undefined ? undefined : await readCoworkerFile(runtime, agent.id, input.attachmentPath, 'attach')
    const { connection, model } = await desktopModel(runtime)
    const engineResponse = await chat(engineOf(runtime), agent.engineAgentId, {
        sessionId: existing?.engineSessionId,
        message: input.text,
        workspaceAttachment: file && { path: file.path, content: file.content },
        connectionId: connection.id,
        model,
        source: 'dashboard',
        author: { id: 'local-profile-1', name: 'Local User' },
    })
    if (!engineResponse.ok || !engineResponse.body) throw new DesktopHttpError(502, 'The engine could not start this conversation')
    const engineSessionId = engineResponse.headers.get('x-session-id')
    if (!engineSessionId) throw new DesktopHttpError(502, 'The engine did not return a conversation ID')
    const session = existing ?? await createDesktopSession(db, { agentId: agent.id, engineSessionId, title: input.text.trim().slice(0, 80) || 'New conversation' })
    const headers = new Headers({
        'content-type': engineResponse.headers.get('content-type') ?? 'text/event-stream',
        'x-vercel-ai-ui-message-stream': engineResponse.headers.get('x-vercel-ai-ui-message-stream') ?? 'v1',
        'x-session-id': session.id,
    })
    const runId = engineResponse.headers.get('x-run-id')
    if (runId) headers.set('x-run-id', runId)
    return { response: new Response(engineResponse.body, { status: 200, headers }), sessionId: session.id }
}

export async function readDesktopHistory(runtime: DesktopRuntime, sessionId: string): Promise<HistoryMessage[]> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    if (!session) throw new DesktopHttpError(404, 'Conversation not found')
    const agent = await findDesktopAgent(db, session.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    try {
        const messages = await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId, { requireSuccess: true })
        return transformEngineMessages(messages, { desktopSummaries: true })
    } catch (cause) {
        if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Conversation not found')
        throw new DesktopHttpError(502, 'Could not load this conversation. Try again.')
    }
}
