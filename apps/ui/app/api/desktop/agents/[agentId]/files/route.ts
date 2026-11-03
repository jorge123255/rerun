import { listCoworkerFiles } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const query = new URL(request.url).searchParams
        const listing = await listCoworkerFiles(runtime, agentId, query.get('path') ?? '', query.get('hidden') === '1')
        return Response.json(listing, { headers: { 'cache-control': 'no-store' } })
    })
}
