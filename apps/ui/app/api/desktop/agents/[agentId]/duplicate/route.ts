import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { duplicateDesktopCoworker, PositionOccupied } from '@/lib/desktop/server/coworker-duplicate'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { engineOf } from '@/lib/desktop/server/settings'
import { desktopAgentView } from '@/lib/desktop/server/views'
import { desktopSpacePositionSchema } from '@/lib/desktop/spaces'

const input = z.strictObject({ requestId: z.uuid(), position: desktopSpacePositionSchema, spaceId: z.uuid().optional() })
type Context = { params: Promise<{ agentId: string }> }

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const parsed = input.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a board position for this copy.')
        try {
            const { requestId, position, spaceId } = parsed.data
            const agent = await duplicateDesktopCoworker(await openDesktopDatabase(runtime.dataRoot), engineOf(runtime), (await params).agentId, requestId, position, spaceId)
            return Response.json({ agent: desktopAgentView(agent) }, { status: 201, headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof PositionOccupied) return Response.json({ error: error.message, code: 'position_occupied' }, { status: 409 })
            throw error
        }
    })
}
