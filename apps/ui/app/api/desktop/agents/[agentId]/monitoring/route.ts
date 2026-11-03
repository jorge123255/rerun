import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopMonitoring } from '@/lib/desktop/server/monitoring'
import { engineOf } from '@/lib/desktop/server/settings'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { monitoringRangeSchema } from '@/lib/desktop/monitoring'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const parsed = monitoringRangeSchema.safeParse(new URL(request.url).searchParams.get('range') ?? '7d')
        if (!parsed.success) throw new DesktopHttpError(400, 'Unknown monitoring range')
        const agent = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
        if (!agent) throw new DesktopHttpError(404, 'Coworker not found')
        try {
            const monitoring = await readDesktopMonitoring(engineOf(runtime), agent, parsed.data)
            return Response.json(monitoring, { headers: { 'cache-control': 'no-store' } })
        } catch {
            throw new DesktopHttpError(502, 'Could not reach this coworker’s monitoring. Try again.')
        }
    })
}
