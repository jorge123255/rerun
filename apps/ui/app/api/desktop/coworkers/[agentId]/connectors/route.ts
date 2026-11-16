import { desktopCoworkerConnectors } from '@/lib/desktop/server/coworker-connectors'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
type Context = { params: Promise<{ agentId: string }> }

// Which apps this coworker's chat tool rows belong to: names and bundled logos only, read from this Mac.
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => Response.json(await desktopCoworkerConnectors(runtime, (await params).agentId), { headers: { 'cache-control': 'no-store' } }))
}
