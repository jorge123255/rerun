import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { searchDesktopChats } from '@/lib/desktop/server/chat-search'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const params = new URL(request.url).searchParams
        const text = (params.get('q') ?? '').trim()
        if (text.length > 200) throw new DesktopHttpError(400, 'Search must be 200 characters or fewer')
        const scopes = params.getAll('agentId')
        if (scopes.length > 1 || (scopes.length === 1 && (!scopes[0].trim() || scopes[0].length > 200))) {
            throw new DesktopHttpError(400, 'Choose one coworker to search')
        }
        const agentId = scopes[0]
        const result = text.length < 2 && agentId === undefined
            ? { hits: [], hasMore: false }
            : await searchDesktopChats(await openDesktopDatabase(runtime.dataRoot), text, agentId)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
