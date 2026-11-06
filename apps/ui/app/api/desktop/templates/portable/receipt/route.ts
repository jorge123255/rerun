import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopPortableServer } from '@/lib/desktop/server/templates/portable-runtime'
export const dynamic = 'force-dynamic'
export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await (await openDesktopPortableServer(runtime, request.signal)).receipt(new URL(request.url).searchParams.get('requestId') ?? ''), { headers: { 'cache-control': 'no-store' } }))
}
