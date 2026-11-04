import { desktopRecentCoworkerVisitSchema } from '@/lib/desktop/recent-coworkers.schema'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopRecentCoworkers, rememberDesktopCoworker } from '@/lib/desktop/server/recent-coworkers'

export const dynamic = 'force-dynamic'
const headers = { 'cache-control': 'no-store' }

export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopRecentCoworkers(await openDesktopDatabase(runtime.dataRoot)), { headers }))
}

export async function POST(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopRecentCoworkerVisitSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid coworker visit')
        const { status, recent } = await rememberDesktopCoworker(await openDesktopDatabase(runtime.dataRoot), parsed.data)
        return Response.json(status === 200 ? recent : { error: 'Recent coworkers changed. Try again.', recent }, { status, headers })
    })
}
