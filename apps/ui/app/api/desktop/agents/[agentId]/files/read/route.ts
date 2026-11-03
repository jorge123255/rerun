import { readCoworkerFile } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const preview = await readCoworkerFile(runtime, agentId, new URL(request.url).searchParams.get('path') ?? '')
        return Response.json(preview, { headers: { 'cache-control': 'no-store' } })
    })
}
