import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { sessionId } = await params
        return Response.json({ messages: await readDesktopHistory(runtime, sessionId) })
    })
}
