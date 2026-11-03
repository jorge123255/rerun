import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopBootstrap } from '@/lib/desktop/server/store'
import { desktopAgentView } from '@/lib/desktop/server/views'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const bootstrap = await readDesktopBootstrap(await openDesktopDatabase(runtime.dataRoot))
        return Response.json({ ...bootstrap, agents: bootstrap.agents.map(desktopAgentView) })
    })
}
