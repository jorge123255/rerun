import { readDesktopControlCenterChats } from '@/lib/desktop/server/control-center-chats'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        return Response.json(await readDesktopControlCenterChats(runtime, agentId, { signal: request.signal }), { headers: { 'cache-control': 'no-store' } })
    })
}
