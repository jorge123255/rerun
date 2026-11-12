import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopHistory, startDesktopChat } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent, findDesktopSession, listDesktopAgents, listDesktopSessions } from '@/lib/desktop/server/store'
import { desktopThreadViews } from '@/lib/desktop/server/thread-views'
import { desktopSessionView } from '@/lib/desktop/server/views'
import { EngineRequestError, getRun } from '@/lib/engine/client'

export const dynamic = 'force-dynamic'

const id = /^[A-Za-z0-9_-]{1,200}$/
const options = { headers: { 'cache-control': 'no-store' } }
const uuid = z.string().uuid()
const turnInput = z.object({ runId: uuid, text: z.string().max(20_000).refine(text => !!text.trim()) }).strict()

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { searchParams } = new URL(request.url)
        const agentId = searchParams.get('agentId')
        const chatId = searchParams.get('chatId')
        const runId = searchParams.get('runId')
        if ((agentId !== null && !id.test(agentId)) || (chatId !== null && (!id.test(chatId) || !agentId))
            || (runId !== null && (!chatId || !uuid.safeParse(runId).success))) {
            throw new DesktopHttpError(404, 'Not found')
        }
        const db = await openDesktopDatabase(runtime.dataRoot)
        if (!agentId) {
            const agents = await listDesktopAgents(db)
            return Response.json({ coworkers: agents.filter(agent => agent.workspaceId === 1)
                .map(agent => ({ id: agent.id, name: agent.name, status: agent.enabled ? 'enabled' : 'disabled' })) }, options)
        }
        const agent = await findDesktopAgent(db, agentId)
        if (!agent) throw new DesktopHttpError(404, 'Not found')
        if (!chatId) {
            const views = await desktopThreadViews(runtime, db, agent, await listDesktopSessions(db, agentId))
            return Response.json({ chats: views.map(({ id, agentId, title, createdAt, updatedAt, kind }) => (
                { id, agentId, title, createdAt, updatedAt, kind }
            )) }, options)
        }
        const chat = await findDesktopSession(db, chatId)
        if (chat?.agentId !== agentId) throw new DesktopHttpError(404, 'Not found')
        if (runId) {
            try {
                const run = await getRun(engineOf(runtime), agent.engineAgentId, runId)
                if (run.id !== runId || run.sessionId !== chat.engineSessionId || run.agentId !== agent.engineAgentId) throw new DesktopHttpError(404, 'Not found')
                return Response.json({ status: run.status }, options)
            } catch (error) {
                if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Not found')
                throw error
            }
        }
        const history = await readDesktopHistory(runtime, chatId, { acknowledgeAlternate: false })
        const { id: savedId, title, createdAt, updatedAt, kind } = desktopSessionView(chat)
        const messages = history.flatMap(message => {
            const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
            return text ? [{ id: message.id, role: message.role, createdAt: message.metadata?.createdAt,
                content: { type: 'text', text } }] : []
        })
        return Response.json({ chat: { id: savedId, agentId, title, createdAt, updatedAt, kind, acceptsMessages: agent.enabled }, messages }, options)
    })
}

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { searchParams } = new URL(request.url)
        const agentId = searchParams.get('agentId')
        const chatId = searchParams.get('chatId')
        if (!agentId || !id.test(agentId) || !chatId || !id.test(chatId)) throw new DesktopHttpError(404, 'Not found')
        const body = turnInput.safeParse(await request.json().catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Write a message.')
        const { runId, text } = body.data
        const { response, sessionId } = await startDesktopChat(runtime, { agentId, sessionId: chatId, text, requestId: runId })
        // The engine drains its own resumable stream. Detach this HTTP subscriber
        // so the phone can poll the durable run without holding a streaming socket.
        void response.body?.cancel().catch(() => {})
        if (sessionId !== chatId || response.headers.get('x-run-id') !== runId) throw new DesktopHttpError(502, 'Could not confirm this message.')
        return Response.json({ runId }, { ...options, status: 202 })
    })
}
