import { z } from 'zod'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopBrowserRun, desktopBrowserRunTicket } from '@/lib/desktop/server/screen/browser-run'
type Context = { params: Promise<{ agentId: string; sessionId: string }> }
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, sessionId } = await params
        const { trusted } = await desktopBrowserRun(runtime, agentId, sessionId, request.signal)
        return Response.json({ trusted }, { headers: { 'cache-control': 'no-store' } })
    })
}
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId, sessionId } = await params
        const parsed = z.strictObject({ runId: z.string().min(1).max(200) }).safeParse(await readDesktopJson(request, 2048))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid browser run')
        const { socketUrl, ticket } = await desktopBrowserRunTicket(runtime, agentId, sessionId, parsed.data.runId, request.signal)
        return Response.json({ socketUrl, expiresAt: ticket.expiresAt }, { headers: { 'cache-control': 'no-store' } })
    })
}
