import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopComputerPanel, launchDesktopComputerApp } from '@/lib/desktop/server/screen/computer-panel'
import { computerPanelLaunchSchema } from '@/lib/desktop/computer-panel/contract'
import { boundedText } from '@/lib/desktop/server/mcp/remote'
type Context = { params: Promise<{ agentId: string; sessionId: string }> }
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => { const { agentId, sessionId } = await params; return Response.json(await readDesktopComputerPanel(runtime, agentId, sessionId, request.signal), { headers: { 'cache-control': 'no-store' } }) })
}
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const parsed = computerPanelLaunchSchema.safeParse(JSON.parse(await boundedText(new Response(request.body), request.signal, 4096)))
        if (!parsed.success) throw new DesktopHttpError(400, 'Unknown launcher request')
        const { agentId, sessionId } = await params
        return Response.json(await launchDesktopComputerApp(runtime, agentId, sessionId, parsed.data, request.signal), { headers: { 'cache-control': 'no-store' } })
    })
}
