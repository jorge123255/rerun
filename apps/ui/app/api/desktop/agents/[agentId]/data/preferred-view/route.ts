import { desktopDataPreferenceRoute } from '@/lib/desktop/server/data-preference-route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }
async function route(request: Request, { params }: Context) {
    return desktopDataPreferenceRoute(request, { kind: 'agent', agentId: (await params).agentId })
}
export { route as GET, route as PUT }
