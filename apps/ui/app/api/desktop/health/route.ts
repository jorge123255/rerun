import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        await openDesktopDatabase(runtime.dataRoot)
        return Response.json({
            protocolVersion: 1,
            launchNonce: runtime.launchNonce,
            buildId: runtime.buildId,
            workspaceId: runtime.workspaceId,
            status: 'ready',
        })
    })
}
