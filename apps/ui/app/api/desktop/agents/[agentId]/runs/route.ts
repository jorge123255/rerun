import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { desktopRunView } from '@/lib/desktop/run-history'
import { listRuns } from '@/lib/engine/client'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const agent = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        try {
            const runs = await listRuns(engineOf(runtime), agent.engineAgentId, { limit: 50 })
            if (runs.some(run => run.agentId !== agent.engineAgentId)) throw new Error('Run belongs to another coworker')
            return Response.json({ runs: runs.map(desktopRunView) }, { headers: { 'cache-control': 'no-store' } })
        } catch {
            throw new DesktopHttpError(502, 'Could not reach this coworker’s run history. Try again.')
        }
    })
}
