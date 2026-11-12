import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopHistory, startDesktopChat } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { phoneReplyStream } from '@/lib/desktop/server/phone-reply'
import { withDesktopSecretSessionTransition } from '@/lib/desktop/server/secret-requests/lifecycle'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent, findDesktopSession, listDesktopAgents, listDesktopSessions } from '@/lib/desktop/server/store'
import { desktopThreadViews } from '@/lib/desktop/server/thread-views'
import { desktopSessionView } from '@/lib/desktop/server/views'
import { cancelRun, EngineRequestError, getRun, reconnectRun } from '@/lib/engine/client'

export const dynamic = 'force-dynamic'

const id = /^[A-Za-z0-9_-]{1,200}$/
const options = { headers: { 'cache-control': 'no-store' } }
const uuid = z.string().uuid()
const turnInput = z.object({ runId: uuid, text: z.string().max(20_000).refine(text => !!text.trim()) }).strict()

async function ownedRun(runtime: DesktopRuntime, engineAgentId: string, engineSessionId: string, runId: string) {
    const conn = engineOf(runtime)
    try {
        const run = await getRun(conn, engineAgentId, runId)
        if (run.id !== runId || run.sessionId !== engineSessionId || run.agentId !== engineAgentId) throw new DesktopHttpError(404, 'Not found')
        return { conn, run }
    } catch (error) {
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Not found')
        throw error
    }
}

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { searchParams } = new URL(request.url)
        const agentId = searchParams.get('agentId')
        const chatId = searchParams.get('chatId')
        const runId = searchParams.get('runId')
        const streaming = searchParams.get('stream') === '1'
        if ((agentId !== null && !id.test(agentId)) || (chatId !== null && (!id.test(chatId) || !agentId))
            || (runId !== null && (!chatId || !uuid.safeParse(runId).success)) || (streaming && !runId)) {
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
            const { conn, run } = await ownedRun(runtime, agent.engineAgentId, chat.engineSessionId, runId)
            if (streaming) {
                if (run.status !== 'running') return new Response(null, { ...options, status: 204 })
                const reply = await reconnectRun(conn, agent.engineAgentId, runId)
                if (reply.status === 204) return new Response(null, { ...options, status: 204 })
                if (!reply.ok || !reply.body) throw new DesktopHttpError(502, 'This reply is unavailable.')
                return new Response(phoneReplyStream(reply.body, runId), {
                    headers: { ...options.headers, 'content-type': 'application/x-ndjson' },
                })
            }
            return Response.json({ status: run.status }, options)
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
        // The engine owns the run and its replay buffer. The phone attaches separately.
        void response.body?.cancel().catch(() => {})
        if (sessionId !== chatId || response.headers.get('x-run-id') !== runId) throw new DesktopHttpError(502, 'Could not confirm this message.')
        return Response.json({ runId }, { ...options, status: 202 })
    })
}

export async function DELETE(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { searchParams } = new URL(request.url)
        const agentId = searchParams.get('agentId')
        const chatId = searchParams.get('chatId')
        const runId = searchParams.get('runId')
        if (!agentId || !id.test(agentId) || !chatId || !id.test(chatId) || !runId || !uuid.safeParse(runId).success) {
            throw new DesktopHttpError(404, 'Not found')
        }
        const db = await openDesktopDatabase(runtime.dataRoot)
        const agent = await findDesktopAgent(db, agentId)
        const chat = await findDesktopSession(db, chatId)
        if (!agent || chat?.agentId !== agentId) throw new DesktopHttpError(404, 'Not found')
        const { conn, run } = await ownedRun(runtime, agent.engineAgentId, chat.engineSessionId, runId)
        if (run.status === 'running') {
            try {
                await withDesktopSecretSessionTransition(runtime, chatId, () => cancelRun(conn, agent.engineAgentId, runId))
            } catch (error) {
                if (!(error instanceof EngineRequestError) || error.status !== 409) {
                    if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Not found')
                    throw new DesktopHttpError(502, 'Could not stop this reply. Try again.')
                }
            }
        }
        // A successful stop request can race a normal completion. Read the run to learn its terminal state.
        return Response.json({ runId }, options)
    })
}
