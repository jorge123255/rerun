import { desktopWorkspaceFileLink } from '@/lib/desktop/workspace-file-link'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { withCoworkerFiles } from '@/lib/desktop/server/coworker-files'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { findDesktopAgent } from '@/lib/desktop/server/store'

type Context = { params: Promise<{ agentId: string }> }

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const body = await readDesktopJson(request, 32 * 1024) as { href?: unknown } | null
        const link = desktopWorkspaceFileLink(typeof body?.href === 'string' ? body.href : undefined)
        if (!link) throw new DesktopHttpError(400, 'Invalid workspace file link')
        const { agentId } = await params
        return withCoworkerFiles(runtime, agentId, async () => {
            const agent = await findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), agentId)
            if (agent?.engineAgentId !== link.owner) throw new DesktopHttpError(404, 'File not found')
            return Response.json({ path: link.path }, { headers: { 'cache-control': 'no-store' } })
        })
    })
}
