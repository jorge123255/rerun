import { authenticateDesktopEngineRequest } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopLocale } from '@/lib/desktop/server/language'

export function POST(request: Request) {
    return desktopRoute(request, async runtime =>
        Response.json({ locale: await readDesktopLocale(runtime, null) }, { headers: { 'cache-control': 'no-store' } }),
    authenticateDesktopEngineRequest)
}
