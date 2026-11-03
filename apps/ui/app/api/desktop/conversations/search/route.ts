import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { searchDesktopChats } from '@/lib/desktop/server/chat-search'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const text = (new URL(request.url).searchParams.get('q') ?? '').trim()
        if (text.length > 200) throw new DesktopHttpError(400, 'Search must be 200 characters or fewer')
        const result = text.length < 2 ? { hits: [], hasMore: false } : await searchDesktopChats(await openDesktopDatabase(runtime.dataRoot), text)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
