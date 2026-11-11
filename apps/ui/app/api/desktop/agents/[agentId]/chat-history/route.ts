import { listSessions } from '@/lib/engine/client'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopChatHistory, type DesktopChatHistory } from '@/lib/desktop/server/chat-history'
import { readDesktopTakeover } from '@/lib/desktop/server/takeover'
import { readDesktopApproval } from '@/lib/desktop/server/approvals'
import { readDesktopQuestion } from '@/lib/desktop/server/questions'
import { readDesktopSecretRequestView } from '@/lib/desktop/server/secret-requests/binding'
import { createDesktopHumanRequestHistory } from '@/lib/desktop/server/human-request-history'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'

export const dynamic = 'force-dynamic'

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
                pendingQuestionFor: async id => {
                    const history = createDesktopHumanRequestHistory(runtime, agent.id)
                    const { question } = await readDesktopQuestion(runtime, id, { history })
                    if (question) return question.questions[0].question.slice(0, 200)
                    const { approval } = await readDesktopApproval(runtime, id, { history })
                    if (approval) return approval.approvals[0].action.slice(0, 200)
                    const takeover = (await readDesktopTakeover(runtime, id, { history })).takeover
                    if (takeover) return takeover.reason.slice(0, 200)
                    const secret = (await readDesktopSecretRequestView(runtime, id)).request
                    return secret ? `Needs ${secret.fields[0].label}`.slice(0, 200) : null
                },
            }, agent)
        } catch {
            throw new DesktopHttpError(503, 'Could not read conversations')
        }
        return Response.json(history, { headers: { 'cache-control': 'no-store' } })
    })
}
