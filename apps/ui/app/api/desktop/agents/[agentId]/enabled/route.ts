import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { setDesktopCoworkerEnabled } from '@/lib/desktop/server/coworker-enabled'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { desktopAgentView } from '@/lib/desktop/server/views'
import { withDesktopMcpOwnerTransition } from '@/lib/desktop/server/mcp-binding'
import { withDesktopSecretOwnerTransition } from '@/lib/desktop/server/secret-requests/lifecycle'

const input = z.strictObject({ enabled: z.boolean() })
type Context = { params: Promise<{ agentId: string }> }

export function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose whether this coworker is enabled.')
        const agentId = (await params).agentId
        const db = await openDesktopDatabase(runtime.dataRoot)
        const agent = await withDesktopSecretOwnerTransition(runtime, agentId, () => withDesktopMcpOwnerTransition(runtime, agentId, () => setDesktopCoworkerEnabled(db, engineOf(runtime), agentId, parsed.data.enabled)))
        return Response.json({ agent: desktopAgentView(agent) }, { headers: { 'cache-control': 'no-store' } })
    })
}
