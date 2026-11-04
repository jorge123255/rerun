import { desktopDataPreferenceRoute } from '@/lib/desktop/server/data-preference-route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
function route(request: Request) { return desktopDataPreferenceRoute(request, { kind: 'shared' }) }
export { route as GET, route as PUT }
