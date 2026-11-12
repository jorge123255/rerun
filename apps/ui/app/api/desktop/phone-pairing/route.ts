import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'
import { findDesktopAgent, findDesktopSession, listDesktopAgents, listDesktopSessions } from '@/lib/desktop/server/store'
import { desktopThreadViews } from '@/lib/desktop/server/thread-views'
import { desktopSessionView } from '@/lib/desktop/server/views'

export const dynamic = 'force-dynamic'

const id = /^[A-Za-z0-9_-]{1,200}$/
const options = { headers: { 'cache-control': 'no-store' } }

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { searchParams } = new URL(request.url)
        const agentId = searchParams.get('agentId')
        const chatId = searchParams.get('chatId')
        if ((agentId !== null && !id.test(agentId)) || (chatId !== null && (!id.test(chatId) || !agentId))) {
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
        const history = await readDesktopHistory(runtime, chatId, { acknowledgeAlternate: false })
        const { id: savedId, title, createdAt, updatedAt, kind } = desktopSessionView(chat)
        const messages = history.flatMap(message => {
            const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
            return text ? [{ id: message.id, role: message.role, createdAt: message.metadata?.createdAt,
                content: { type: 'text', text } }] : []
        })
        return Response.json({ chat: { id: savedId, agentId, title, createdAt, updatedAt, kind }, messages }, options)
    })
}
