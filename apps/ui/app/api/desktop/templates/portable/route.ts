import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopPortableServer, readPortableRequest } from '@/lib/desktop/server/templates/portable-runtime'
export const dynamic = 'force-dynamic'
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = await readPortableRequest(request)
        const result = await (await openDesktopPortableServer(runtime, request.signal)).handle(parsed)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
