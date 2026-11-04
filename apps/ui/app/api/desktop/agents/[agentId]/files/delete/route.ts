import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { deleteCoworkerFile } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Delete one confirmed file or folder inside this coworker’s workspace. */
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const body = await request.json().catch(() => null) as { path?: unknown; identity?: unknown } | null
        if (!body || typeof body.path !== 'string') throw new DesktopHttpError(400, 'Send the file or folder to delete.')
        if (body.identity !== undefined && typeof body.identity !== 'string') throw new DesktopHttpError(400, 'Send the file or folder to delete.')
        const removed = await deleteCoworkerFile(runtime, agentId, body.path, body.identity)
        return Response.json(removed, { headers: { 'cache-control': 'no-store' } })
    })
}
