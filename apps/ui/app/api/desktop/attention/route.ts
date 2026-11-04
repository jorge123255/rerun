import { readDesktopAttention } from '@/lib/desktop/server/attention'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopAttention(runtime), { headers: { 'cache-control': 'no-store' } }))
}
