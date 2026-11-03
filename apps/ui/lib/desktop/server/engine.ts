import 'server-only'
import { chat, createAgent, createConnection, getSessionMessages, updateConnectionKeys } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { transformEngineMessages, type HistoryMessage } from '@/lib/chat/engine-history'
import { sanitizeIdentifier } from '@/lib/utils'
import { DEFAULT_CONNECTION_MODELS } from '@rerun/contracts'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { createDesktopAgent, createDesktopSession, findDesktopAgent, findDesktopSession, listDesktopConnections, saveDesktopConnection, type DesktopConnection } from './store'

function engineOf(runtime: DesktopRuntime): EngineConnection {
    return { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
}

export async function connectDesktopOpenAI(runtime: DesktopRuntime, apiKey: string): Promise<DesktopConnection> {
    const key = apiKey.trim()
    if (!key) throw new DesktopHttpError(400, 'An OpenAI API key is required')
    const db = await openDesktopDatabase(runtime.dataRoot)
    const existing = (await listDesktopConnections(db))[0]
    if (existing) {
        await updateConnectionKeys(engineOf(runtime), existing.id, { set: { OPENAI_API_KEY: key } })
        return existing
    }
    const created = await createConnection(engineOf(runtime), {
        name: 'OpenAI',
        provider: 'openai',
        models: DEFAULT_CONNECTION_MODELS.openai,
        extraModels: [],
        keys: { OPENAI_API_KEY: key },
    })
    const connection = { id: created.id, provider: 'openai' as const, name: created.name }
    await saveDesktopConnection(db, connection)
    return connection
}

export async function createDesktopCoworker(runtime: DesktopRuntime, input: { name: string; description?: string }) {
    const name = input.name.trim()
    if (!name || name.length > 60) throw new DesktopHttpError(400, 'Coworker name must be between 1 and 60 characters')
    const description = input.description?.trim() ?? ''
    if (description.length > 2000) throw new DesktopHttpError(400, 'Description is too long')
    const db = await openDesktopDatabase(runtime.dataRoot)
    const connection = (await listDesktopConnections(db))[0]
    const handle = `${sanitizeIdentifier(name).replace(/^_+|_+$/g, '') || 'coworker'}-${crypto.randomUUID().slice(0, 8)}`
    const created = await createAgent(engineOf(runtime), {
        config: {
            name: handle,
            displayName: name,
            description,
            enabled: true,
            connectionId: connection?.id ?? null,
            provider: connection ? 'openai' : null,
            model: null,
        },
    })
    return createDesktopAgent(db, { engineAgentId: created.id, name, description })
}

export async function startDesktopChat(runtime: DesktopRuntime, input: { agentId: string; sessionId?: string; text: string }): Promise<{ response: Response; sessionId: string }> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const agent = await findDesktopAgent(db, input.agentId)
    if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
    const existing = input.sessionId ? await findDesktopSession(db, input.sessionId) : null
    if (input.sessionId && (!existing || existing.agentId !== agent.id)) throw new DesktopHttpError(404, 'Conversation not found')
    const connection = (await listDesktopConnections(db))[0]
    const engineResponse = await chat(engineOf(runtime), agent.engineAgentId, {
        sessionId: existing?.engineSessionId,
        message: input.text,
        connectionId: connection?.id,
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
    return transformEngineMessages(await getSessionMessages(engineOf(runtime), agent.engineAgentId, session.engineSessionId))
}
