import { readDesktopCoworkerPreviews } from '@/lib/desktop/server/coworker-previews'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopCoworkerPreviews(await openDesktopDatabase(runtime.dataRoot)), { headers: { 'cache-control': 'no-store' } }))
}
