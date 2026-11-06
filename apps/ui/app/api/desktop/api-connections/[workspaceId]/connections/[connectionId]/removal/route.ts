import { createApiConnectionsRouteHandlers } from '@/lib/desktop/api-connections/server'
import { desktopApiConnectionEngineRoutes } from '@/lib/desktop/api-connections/routes'

export const dynamic = 'force-dynamic'

const handlers = createApiConnectionsRouteHandlers(desktopApiConnectionEngineRoutes)

export async function GET(request: Request, { params }: { params: Promise<{ workspaceId: string; connectionId: string }> }): Promise<Response> {
    const { workspaceId, connectionId } = await params
    return handlers.removalPlan(request, workspaceId, connectionId)
}
