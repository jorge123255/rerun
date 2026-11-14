import { request } from '@/lib/engine/client'
import { coworkerPreviewEngine, readDesktopCoworkerPreviews } from '@/lib/desktop/server/coworker-previews'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
    return desktopRoute(req, async runtime => {
        const engine = coworkerPreviewEngine((path, signal, parse) => request(engineOf(runtime), path, { method: 'GET', cache: 'no-store', signal }, parse))
        return Response.json(await readDesktopCoworkerPreviews(await openDesktopDatabase(runtime.dataRoot), engine, req.signal), { headers: { 'cache-control': 'no-store' } })
    })
}
