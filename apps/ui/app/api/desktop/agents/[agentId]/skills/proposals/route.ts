import { listCoworkerSkillProposals } from '@/lib/desktop/server/coworker-skills'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const query = new URL(request.url).searchParams
        const sessionId = query.get('sessionId') ?? undefined
        if (query.getAll('sessionId').length > 1 || (sessionId !== undefined && (!sessionId || sessionId.length > 128))) throw new DesktopHttpError(400, 'Choose a chat to review.')
        const snapshot = await listCoworkerSkillProposals(runtime, agentId, sessionId)
        return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } })
    })
}
