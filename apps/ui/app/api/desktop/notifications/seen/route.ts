import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { acknowledgeDesktopNotificationEvents } from '@/lib/desktop/server/notifications'

export const dynamic = 'force-dynamic'

const acknowledged = z.object({ keys: z.array(z.string().min(1).max(600)).max(200) }).strict()

// Recorded only after the mounted delivery announced the events, so a failed delivery can come
// back on the next poll instead of being lost.
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = acknowledged.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Send the notification keys to acknowledge.')
        await acknowledgeDesktopNotificationEvents(await openDesktopDatabase(runtime.dataRoot), parsed.data.keys)
        return Response.json({ acknowledged: parsed.data.keys.length }, { headers: { 'cache-control': 'no-store' } })
    })
}
