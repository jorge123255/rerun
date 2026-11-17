import { desktopSidebarListChangeSchema } from '@/lib/desktop/workspace-view'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopSidebarList, saveDesktopSidebarList } from '@/lib/desktop/server/workspace-view'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }

// The Simple view's list: the Boxes folded away and the order someone dragged it into.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopSidebarList(await openDesktopDatabase(runtime.dataRoot)), { headers }))
}

export async function PUT(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopSidebarListChangeSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'That change to the list is not valid.')
        return Response.json(await saveDesktopSidebarList(await openDesktopDatabase(runtime.dataRoot), parsed.data), { headers })
    })
}
