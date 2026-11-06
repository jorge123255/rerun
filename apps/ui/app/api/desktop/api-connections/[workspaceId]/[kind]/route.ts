import { createApiConnectionsRouteHandlers } from '@/lib/desktop/api-connections/server'
import { desktopApiConnectionEngineRoutes } from '@/lib/desktop/api-connections/routes'

export const dynamic = 'force-dynamic'

const handlers = createApiConnectionsRouteHandlers(desktopApiConnectionEngineRoutes)

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; kind: string }> }): Promise<Response> {
    const { workspaceId, kind } = await params
    return handlers.mutation(request, workspaceId, kind)
}