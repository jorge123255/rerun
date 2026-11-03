import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { EngineRequestError, listMemories } from '@/lib/engine/client'

export const dynamic = 'force-dynamic'

export function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const coworker = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
        if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
        try {
            const memories = await listMemories(engineOf(runtime), coworker.engineAgentId)
            return Response.json({ memories }, { headers: { 'cache-control': 'no-store' } })
        } catch (cause) {
            if (cause instanceof EngineRequestError && cause.status === 404) throw new DesktopHttpError(404, 'Coworker not found')
            throw new DesktopHttpError(502, 'Could not load this coworker’s memories.')
        }
    })
}
