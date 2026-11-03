import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { writeDesktopTabs } from '@/lib/desktop/server/session-tabs'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { desktopTabWriteSchema } from '@/lib/desktop/session-tabs'

export async function PUT(request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const input = desktopTabWriteSchema.safeParse(await request.json().catch(() => null))
        if (!input.success) throw new DesktopHttpError(400, 'Invalid conversation tabs')
        const { agentId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        if (!(await findDesktopAgent(db, agentId))) throw new DesktopHttpError(404, 'Coworker not found')
        const { conflict, tabs } = await writeDesktopTabs(db, agentId, input.data)
        if (conflict) return Response.json({ error: 'Open chats changed. Reload the tabs and try again.', tabs }, { status: 409 })
        return Response.json({ tabs })
    })
}
