import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { clearDesktopActivity, readDesktopActivity } from '@/lib/desktop/server/activity'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        try {
            const view = await readDesktopActivity(engineOf(runtime), await openDesktopDatabase(runtime.dataRoot), new URL(request.url).searchParams)
            return Response.json(view, { headers: { 'cache-control': 'no-store' } })
        } catch {
            throw new DesktopHttpError(502, 'Could not read the activity. Try again.')
        }
    })
}

/** Clears the whole trail. The view asks the person to confirm first. */
export async function DELETE(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        try {
            await clearDesktopActivity(engineOf(runtime))
            return Response.json({ cleared: true }, { headers: { 'cache-control': 'no-store' } })
        } catch {
            throw new DesktopHttpError(502, 'Could not clear the activity. Try again.')
        }
    })
}
