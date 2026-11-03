import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopChats } from '@/lib/desktop/server/session-tabs'
import { engineOf } from '@/lib/desktop/server/settings'
import { recoverPendingTabSessions } from '@/lib/desktop/server/tab-starts'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { desktopSessionView } from '@/lib/desktop/server/views'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        const agent = await findDesktopAgent(db, agentId)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        await recoverPendingTabSessions(db, engineOf(runtime), agent, runtime.launchNonce)
        const { sessions, tabs } = await readDesktopChats(db, agentId)
        return Response.json({ sessions: sessions.map(desktopSessionView), tabs }, { headers: { 'cache-control': 'no-store' } })
    })
}
