import { desktopNotificationReceiptSchema } from '@/lib/desktop/notifications'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readNotificationBody } from '@/lib/desktop/server/notification-body'
import { settleDesktopUserNotification } from '@/lib/desktop/server/user-notifications'
import { finishDesktopNotificationAttempt } from '@/lib/desktop/server/notifications'

export const dynamic = 'force-dynamic'
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopNotificationReceiptSchema.safeParse(await readNotificationBody(request))
        if (!parsed.success) throw new DesktopHttpError(400, 'Send a valid notification delivery result.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        const input = parsed.data
        const recorded = input.key.startsWith('notify-user:')
            ? await settleDesktopUserNotification(runtime, db, input)
            : (await finishDesktopNotificationAttempt(db, input), true)
        return Response.json({ recorded }, { headers: { 'cache-control': 'no-store' } })
    })
}
