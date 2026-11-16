import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { exportDesktopActivity } from '@/lib/desktop/server/activity'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        try {
            const csv = await exportDesktopActivity(engineOf(runtime), await openDesktopDatabase(runtime.dataRoot), new URL(request.url).searchParams)
            return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="rerun-activity.csv"', 'cache-control': 'no-store' } })
        } catch {
            throw new DesktopHttpError(502, 'Could not export the activity. Try again.')
        }
    })
}
