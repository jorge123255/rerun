import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { deleteDesktopCoworker } from '@/lib/desktop/server/coworker-delete'
import { renameDesktopCoworker } from '@/lib/desktop/server/coworker-rename'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { desktopAgentView } from '@/lib/desktop/server/views'
import { withDesktopMcpOwnerTransition } from '@/lib/desktop/server/mcp-binding'
import { withDesktopSecretOwnerTransition } from '@/lib/desktop/server/secret-requests/lifecycle'

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

const deleteInput = z.strictObject({ confirmationName: z.string().trim().min(1).max(60) })

export function DELETE(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const parsed = deleteInput.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Type the coworker’s name to confirm deletion.')
        const agentId = (await params).agentId
        const db = await openDesktopDatabase(runtime.dataRoot)
        const deleted = await withDesktopSecretOwnerTransition(runtime, agentId, () => withDesktopMcpOwnerTransition(runtime, agentId, () => deleteDesktopCoworker(db, engineOf(runtime), agentId, parsed.data.confirmationName)))
        return Response.json(deleted, { headers: { 'cache-control': 'no-store' } })
    })
}
