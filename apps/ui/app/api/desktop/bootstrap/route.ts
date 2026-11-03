import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopWorkspace } from '@/lib/desktop/server/settings'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await readDesktopWorkspace(runtime)))
}
