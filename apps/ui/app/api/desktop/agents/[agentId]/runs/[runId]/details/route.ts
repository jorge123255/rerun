import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { desktopRunDetailsView } from '@/lib/desktop/run-details'
import { EngineRequestError, getRunSteps, getRunTools } from '@/lib/engine/client'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string; runId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId, runId } = await params
        const agent = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        try {
            const conn = engineOf(runtime)
            const [steps, tools] = await Promise.all([getRunSteps(conn, agent.engineAgentId, runId), getRunTools(conn, agent.engineAgentId, runId)])
            if ([...steps, ...tools].some(row => row.agentId !== agent.engineAgentId || row.runId !== runId)) throw new Error('Mismatched run detail')
            return Response.json(desktopRunDetailsView(steps, tools), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Run not found for this coworker')
            throw new DesktopHttpError(502, 'Could not load run details. Try again.')
        }
    })
}
