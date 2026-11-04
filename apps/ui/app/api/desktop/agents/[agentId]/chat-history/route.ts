import { listSessions } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopChatHistory, type DesktopChatHistory, type DesktopChatHistoryDependencies } from '@/lib/desktop/server/chat-history'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'

export const dynamic = 'force-dynamic'

// C5 supplies the read-only pending-question resolver at integration. Until then no conversation is
// marked as needing the user: an engine status or an assistant message is not a pending request.
const pendingQuestionFor: DesktopChatHistoryDependencies['pendingQuestionFor'] = async () => null

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        const agent = await findDesktopAgent(db, agentId)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        const engine = engineOf(runtime)
        let history: DesktopChatHistory
        try {
            history = await readDesktopChatHistory({
                listLocalSessions: id => listDesktopSessions(db, id),
                listEngineSessions: id => listSessions(engine, id),
                pendingQuestionFor,
            }, agent)
        } catch {
            throw new DesktopHttpError(503, 'Could not read conversations')
        }
        return Response.json(history, { headers: { 'cache-control': 'no-store' } })
    })
}
