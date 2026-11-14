import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readNotificationBody } from '@/lib/desktop/server/notification-body'
import { admitDesktopNotificationEvents } from '@/lib/desktop/server/notifications'

export const dynamic = 'force-dynamic'
const input = z.object({ keys: z.array(z.string().min(8).max(600)).max(50) }).strict()
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await readNotificationBody(request))
        if (!parsed.success) throw new DesktopHttpError(400, 'Send valid notification identities.')
        return Response.json(await admitDesktopNotificationEvents(runtime, parsed.data.keys, request.headers.get('accept-language')), { headers: { 'cache-control': 'no-store' } })
    })
}
