import { desktopCoworkerCallTargets } from '@/lib/desktop/server/coworker-calls/targets'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }
export async function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => Response.json(await desktopCoworkerCallTargets(runtime, (await params).agentId, undefined, request.signal), { headers: { 'cache-control': 'no-store' } }))
}
export async function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => Response.json(await desktopCoworkerCallTargets(runtime, (await params).agentId, await readDesktopJson(request, 16_000), request.signal), { headers: { 'cache-control': 'no-store' } }))
}
