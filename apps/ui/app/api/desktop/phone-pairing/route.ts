import { z } from 'zod'
import { desktopApprovalPayloadSchema } from '@/lib/desktop/approvals'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopHistory, startDesktopChat, startDesktopPhoneConversation } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { answerDesktopApproval, readDesktopApproval } from '@/lib/desktop/server/approvals'
import { readPhonePending } from '@/lib/desktop/server/phone-chat-pending'
import { phoneReplyStream } from '@/lib/desktop/server/phone-reply'
import { answerDesktopQuestion, readDesktopQuestion } from '@/lib/desktop/server/questions'
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
const newConversationInput = z.object({ chatId: uuid, runId: uuid, text: z.string().max(20_000).refine(text => !!text.trim()) }).strict()
const turnInput = z.object({ runId: uuid, text: z.string().max(20_000).refine(text => !!text.trim()) }).strict()
// The decisions on the approval a chat waits on, one for each action its card shows. The Mac finds its
// saved approval itself and records them through the path its own card uses, receipts and checks included.
const approvalInput = z.object({ runId: uuid, approval: z.object({
    toolCallId: z.string().min(1).max(256),
    decisions: desktopApprovalPayloadSchema.shape.decisions,
}).strict() }).strict()
// The answer to the question a chat waits on. The phone names the card it was shown, never the saved
// question: the Mac finds that itself, and records the answer the way its own form does.
const answerInput = z.object({ runId: uuid, answer: z.object({
    toolCallId: z.string().min(1).max(256),
    answers: z.array(z.array(z.string().max(4000)).max(100)).min(1).max(32).optional(),
}).strict() }).strict()

async function ownedChat(runtime: DesktopRuntime, agentId: string, chatId: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const agent = await findDesktopAgent(db, agentId)
    const chat = await findDesktopSession(db, chatId)
    if (!agent || chat?.agentId !== agentId) throw new DesktopHttpError(404, 'Not found')
    return { agent, chat }
}

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
            return Response.json({ acceptsMessages: agent.enabled, chats: views.map(({ id, agentId, title, createdAt, updatedAt, kind }) => (
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
        return Response.json({ chat: { id: savedId, agentId, title, createdAt, updatedAt, kind, acceptsMessages: agent.enabled }, messages, pending: await readPhonePending(runtime, db, chat) }, options)
    })
}

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { searchParams } = new URL(request.url)
        const agentId = searchParams.get('agentId')
        const chatId = searchParams.get('chatId')
        if (!agentId || !id.test(agentId) || (chatId !== null && !id.test(chatId))) throw new DesktopHttpError(404, 'Not found')
        const input = await request.json().catch(() => null)
        if (chatId === null) {
            const body = newConversationInput.safeParse(input)
            if (!body.success) throw new DesktopHttpError(400, 'Write a message.')
            const { chatId: newId, runId, text } = body.data
            const { response, sessionId } = await startDesktopPhoneConversation(runtime, { agentId, text }, { sessionId: newId, runId })
            void response.body?.cancel().catch(() => {})
            if (sessionId !== newId || response.headers.get('x-run-id') !== runId) throw new DesktopHttpError(502, 'Could not confirm this conversation.')
            return Response.json({ runId, chatId: sessionId }, { ...options, status: 202 })
        }
        const decided = approvalInput.safeParse(input)
        if (decided.success) {
            const { runId, approval } = decided.data
            const { agent, chat } = await ownedChat(runtime, agentId, chatId)
            const pending = (await readDesktopApproval(runtime, chatId)).approval
            if (!pending) {
                // Sent twice: the first one was taken, and its run says so.
                await ownedRun(runtime, agent.engineAgentId, chat.engineSessionId, runId).catch(() => { throw new DesktopHttpError(409, 'This approval is no longer waiting for decisions.') })
                return Response.json({ runId }, { ...options, status: 202 })
            }
            // One decision for each action the card shows, on the card the phone was shown.
            if (pending.toolCallId !== approval.toolCallId || approval.decisions.length !== pending.approvals.length) {
                throw new DesktopHttpError(409, 'This approval is no longer waiting for decisions.')
            }
            const response = await answerDesktopApproval(runtime, chatId, { approvalId: pending.id, requestId: runId, decisions: approval.decisions })
            void response.body?.cancel().catch(() => {})
            if (response.headers.get('x-run-id') !== runId) throw new DesktopHttpError(502, 'Could not confirm these decisions.')
            return Response.json({ runId }, { ...options, status: 202 })
        }
        const answered = answerInput.safeParse(input)
        if (answered.success) {
            const { runId, answer } = answered.data
            const { agent, chat } = await ownedChat(runtime, agentId, chatId)
            const pending = (await readDesktopQuestion(runtime, chatId)).question
            if (!pending) {
                // Sent twice: the first one was taken, and its run says so.
                await ownedRun(runtime, agent.engineAgentId, chat.engineSessionId, runId).catch(() => { throw new DesktopHttpError(409, 'This question is no longer waiting for an answer.') })
                return Response.json({ runId }, { ...options, status: 202 })
            }
            if (pending.toolCallId !== answer.toolCallId || (answer.answers && answer.answers.length !== pending.questions.length)) {
                throw new DesktopHttpError(409, 'This question is no longer waiting for an answer.')
            }
            const response = await answerDesktopQuestion(runtime, chatId, answer.answers
                ? { action: 'answer', questionId: pending.id, requestId: runId, answers: answer.answers }
                : { action: 'cancel', questionId: pending.id, requestId: runId })
            void response.body?.cancel().catch(() => {})
            if (response.headers.get('x-run-id') !== runId) throw new DesktopHttpError(502, 'Could not confirm this answer.')
            return Response.json({ runId }, { ...options, status: 202 })
        }
        const body = turnInput.safeParse(input)
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
        const { agent, chat } = await ownedChat(runtime, agentId, chatId)
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
