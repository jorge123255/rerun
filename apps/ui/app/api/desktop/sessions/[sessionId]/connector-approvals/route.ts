import { desktopConnectorApprovalActionSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { decideConnectorApproval, forgetConnectorRule, readConnectorApprovals } from '@/lib/desktop/server/connector-approvals/store'
import { tellConnectorCaller } from '@/lib/desktop/server/connector-approvals/tell-caller'
import { startDesktopChat } from '@/lib/desktop/server/engine'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Params = { params: Promise<{ sessionId: string }> }
const SESSION = /^[\w.:-]{1,200}$/

// A held call is recorded under the engine's session; the chat names its own. A chat that has
// not reached the engine yet has nothing waiting.
async function session(db: Awaited<ReturnType<typeof openDesktopDatabase>>, params: Params['params']) {
    const { sessionId } = await params
    if (!SESSION.test(sessionId)) throw new DesktopHttpError(400, 'This conversation is not available.')
    const row = (await db.execute({ sql: 'SELECT engine_session_id FROM desktop_sessions WHERE id=?', args: [sessionId] })).rows[0]
    return typeof row?.engine_session_id === 'string' && row.engine_session_id ? row.engine_session_id : null
}

// The connector actions waiting for the person's answer in this conversation, and the standing
// answers that reach it.
export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot), engineSession = await session(db, params)
        return Response.json(engineSession ? await readConnectorApprovals(db, engineSession) : { pending: [], rules: [] }, { headers: { 'cache-control': 'no-store' } })
    })
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopConnectorApprovalActionSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose an answer for this action.')
        const db = await openDesktopDatabase(runtime.dataRoot), sessionId = await session(db, params)
        if (!sessionId) throw new DesktopHttpError(409, 'This action was already answered.')
        if (parsed.data.action === 'forget') {
            if (!await forgetConnectorRule(db, sessionId, parsed.data.ruleId)) throw new DesktopHttpError(409, 'This was already turned off.')
            return Response.json({ ok: true })
        }
        const result = await decideConnectorApproval(db, sessionId, parsed.data.id, parsed.data.decision)
        if (!result) throw new DesktopHttpError(409, 'This action was already answered.')
        // A chat opened by another coworker's call: that caller did not see the card, so it is told the answer.
        // It runs after this response; the answer stands whether or not the caller can be reached.
        const chatId = (await params).sessionId
        void tellConnectorCaller(db, chatId, result, {
            async coworker(agentId, callerSessionId, text) {
                const { response } = await startDesktopChat(runtime, { agentId, sessionId: callerSessionId, text })
                await response.arrayBuffer()
            },
            async foreman(foremanChatId, requestId, text) {
                await (await desktopForeman(runtime)).send({ workspaceId: String(runtime.workspaceId), chatId: foremanChatId }, requestId, text)
            },
        }).catch(() => {})
        return Response.json(result)
    })
}
