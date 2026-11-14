import { desktopWorkspaceViewChangeSchema } from '@/lib/desktop/workspace-view'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopWorkspaceView, saveDesktopWorkspaceView } from '@/lib/desktop/server/workspace-view'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopWorkspaceView(await openDesktopDatabase(runtime.dataRoot)), { headers }))
}

export async function PUT(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopWorkspaceViewChangeSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the board or the Simple view.')
        return Response.json(await saveDesktopWorkspaceView(await openDesktopDatabase(runtime.dataRoot), parsed.data), { headers })
    })
}
