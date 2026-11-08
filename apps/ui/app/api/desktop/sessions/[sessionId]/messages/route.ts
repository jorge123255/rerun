import { readDesktopRunRecovery } from '@/lib/desktop/server/chat-resume'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { sessionId } = await params
        const messages = await readDesktopHistory(runtime, sessionId)
        const recovery = await readDesktopRunRecovery(runtime, sessionId)
        return Response.json({ messages, lastError: recovery.lastError, activeRunId: recovery.activeRunId, runsUnavailable: recovery.runsUnavailable }, { headers: { 'cache-control': 'no-store' } })
    })
}
