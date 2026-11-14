import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopNotificationEvents } from '@/lib/desktop/server/notifications'

export const dynamic = 'force-dynamic'

// The events worth announcing right now: everything the scope, the coworker rules and the
// install-time cutoff want, minus anything already announced. A poll, a reconnect or a restart
// never replays old history as new.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const events = await readDesktopNotificationEvents(runtime, request.headers.get('accept-language'))
        return Response.json(events, { headers: { 'cache-control': 'no-store' } })
    })
}
