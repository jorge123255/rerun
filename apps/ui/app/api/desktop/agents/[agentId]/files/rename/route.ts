import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { renameCoworkerFile } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Rename one file or folder inside the folder it already occupies. */
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const body = await request.json().catch(() => null) as { path?: unknown; name?: unknown } | null
        if (!body || typeof body.path !== 'string' || typeof body.name !== 'string') throw new DesktopHttpError(400, 'Send the file or folder and its new name.')
        const renamed = await renameCoworkerFile(runtime, agentId, body.path, body.name)
        return Response.json(renamed, { headers: { 'cache-control': 'no-store' } })
    })
}
