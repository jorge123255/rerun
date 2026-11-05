import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { engineOf } from '@/lib/desktop/server/settings'
import { request as engineRequest } from '@/lib/engine/client'
import { prepareTemplateIntent, readTemplateInstallIntent } from '@/lib/desktop/server/templates/intents'
export const dynamic = 'force-dynamic'
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const result = await readTemplateInstallIntent(await openDesktopDatabase(runtime.dataRoot), Object.fromEntries(new URL(request.url).searchParams))
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const engine = engineOf(runtime)
        const result = await prepareTemplateIntent(await openDesktopDatabase(runtime.dataRoot), {
            get: (path, signal) => engineRequest(engine, path, { signal }, value => value),
            post: (path, body, signal) => engineRequest(engine, path, { method: 'POST', body: JSON.stringify(body), signal }, value => value),
        }, await request.json())
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
