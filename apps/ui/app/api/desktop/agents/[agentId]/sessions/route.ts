import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopChats } from '@/lib/desktop/server/session-tabs'
import { engineOf } from '@/lib/desktop/server/settings'
import { recoverPendingTabSessions } from '@/lib/desktop/server/tab-starts'
import { findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { desktopThreadViews } from '@/lib/desktop/server/thread-views'
import { recoverDesktopScheduleHistory } from '@/lib/desktop/server/schedules/recovery'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        const agent = await findDesktopAgent(db, agentId)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        if (new URL(request.url).searchParams.get('view') === 'threads') {
            const sessions = await listDesktopSessions(db, agentId)
            return Response.json({ sessions: await desktopThreadViews(runtime, db, agent, sessions) }, { headers: { 'cache-control': 'no-store' } })
        }
        await recoverPendingTabSessions(db, engineOf(runtime), agent, runtime.launchNonce)
        const scheduledHistoryRecovered = await recoverDesktopScheduleHistory(runtime, db, agentId)
        const { sessions, tabs } = await readDesktopChats(db, agentId)
        return Response.json({ sessions: await desktopThreadViews(runtime, db, agent, sessions), tabs, ...(!scheduledHistoryRecovered && { scheduledHistoryWarning: 'Some scheduled chats could not be checked. Your saved chats are available.' }) }, { headers: { 'cache-control': 'no-store' } })
    })
}
