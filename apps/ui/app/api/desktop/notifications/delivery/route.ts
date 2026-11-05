import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readNotificationBody } from '@/lib/desktop/server/notification-body'
import { finishDesktopNotificationAttempt } from '@/lib/desktop/server/notifications'

export const dynamic = 'force-dynamic'
const input = z.object({ key: z.string().min(8).max(600), attemptId: z.string().uuid(), status: z.enum(['shown', 'unavailable', 'failed', 'unknown']) }).strict()
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await readNotificationBody(request))
        if (!parsed.success) throw new DesktopHttpError(400, 'Send a valid notification delivery result.')
        await finishDesktopNotificationAttempt(await openDesktopDatabase(runtime.dataRoot), parsed.data)
        return Response.json({ recorded: true }, { headers: { 'cache-control': 'no-store' } })
    })
}
