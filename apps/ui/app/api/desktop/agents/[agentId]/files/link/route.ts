import { desktopWorkspaceFileLink } from '@/lib/desktop/workspace-file-link'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { assertWorkspaceLinkOwner, withCoworkerFiles } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'

type Context = { params: Promise<{ agentId: string }> }

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const body = await readDesktopJson(request, 32 * 1024) as { href?: unknown } | null
        const link = desktopWorkspaceFileLink(typeof body?.href === 'string' ? body.href : undefined)
        if (!link) throw new DesktopHttpError(400, 'Invalid workspace file link')
        const { agentId } = await params
        return withCoworkerFiles(runtime, agentId, async () => {
            await assertWorkspaceLinkOwner(runtime, agentId, link.owner)
            return Response.json({ path: link.path }, { headers: { 'cache-control': 'no-store' } })
        })
    })
}
