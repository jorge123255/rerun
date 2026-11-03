import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { renameDesktopCoworker } from '@/lib/desktop/server/coworker-rename'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { desktopAgentView } from '@/lib/desktop/server/views'

const input = z.strictObject({ name: z.string().trim().min(1).max(60) })
type Context = { params: Promise<{ agentId: string }> }

export function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'A coworker name of 1–60 characters is required')
        const agent = await renameDesktopCoworker(await openDesktopDatabase(runtime.dataRoot), engineOf(runtime), runtime.launchNonce, (await params).agentId, parsed.data.name)
        return Response.json({ agent: desktopAgentView(agent) }, { headers: { 'cache-control': 'no-store' } })
    })
}
