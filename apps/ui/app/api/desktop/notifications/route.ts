import { notificationPrefsPatchSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopNotificationPrefs, writeDesktopNotificationPrefs } from '@/lib/desktop/server/notifications'

export const dynamic = 'force-dynamic'

// The durable local preferences: the original scope, channels and per-coworker rules, stored on
// this Mac and merged like the original write (whole object back, one field never clobbers the
// rest). The hosted email channel stays out of the surface and out of delivery.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const prefs = await readDesktopNotificationPrefs(await openDesktopDatabase(runtime.dataRoot))
        return Response.json(prefs, { headers: { 'cache-control': 'no-store' } })
    })
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = notificationPrefsPatchSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid notification scope, channel or coworker rule.')
        const prefs = await writeDesktopNotificationPrefs(await openDesktopDatabase(runtime.dataRoot), parsed.data)
        return Response.json(prefs, { headers: { 'cache-control': 'no-store' } })
    })
}
