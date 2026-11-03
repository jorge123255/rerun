import { memoryRecallQuerySchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { withCoworkerMemories } from '@/lib/desktop/server/memories'
import { recallMemories } from '@/lib/engine/client'

export function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async runtime => {
        const body = memoryRecallQuerySchema.safeParse(await request.json().catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Enter a search query and a valid result limit.')
        const { agentId } = await params
        const memories = await withCoworkerMemories(runtime, agentId, (engine, id) => recallMemories(engine, id, body.data))
        return Response.json({ memories }, { headers: { 'cache-control': 'no-store' } })
    })
}
