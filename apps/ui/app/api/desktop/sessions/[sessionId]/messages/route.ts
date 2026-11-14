import { readDesktopRunRecovery } from '@/lib/desktop/server/chat-resume'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { sessionId } = await params
        // The run version must not describe a newer turn than the transcript read.
        const recovery = await readDesktopRunRecovery(runtime, sessionId)
        const messages = await readDesktopHistory(runtime, sessionId)
        return Response.json({ messages, lastError: recovery.lastError, activeRunId: recovery.activeRunId, runsUnavailable: recovery.runsUnavailable, runVersion: recovery.runVersion }, { headers: { 'cache-control': 'no-store' } })
    })
}
