import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { desktopSessionView } from '@/lib/desktop/server/views'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        if (!(await findDesktopAgent(db, agentId))) throw new DesktopHttpError(404, 'Coworker not found')
        const sessions = await listDesktopSessions(db, agentId)
        return Response.json({ sessions: sessions.map(desktopSessionView) })
    })
}
