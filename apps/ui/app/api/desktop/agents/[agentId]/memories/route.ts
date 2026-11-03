import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { withCoworkerMemories } from '@/lib/desktop/server/memories'
import { createMemory, listMemories } from '@/lib/engine/client'
import { desktopMemoryCreateSchema } from '@rerun/contracts'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const memories = await withCoworkerMemories(runtime, agentId, listMemories)
        return Response.json({ memories }, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const body = desktopMemoryCreateSchema.safeParse(await request.json().catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Enter memory content and valid optional kind and tags.')
        const { agentId } = await params
        const created = await withCoworkerMemories(runtime, agentId, (engine, id) => createMemory(engine, id, body.data))
        if (!created?.id) throw new DesktopHttpError(502, 'Could not confirm the memory was saved. Try again.')
        return Response.json({ id: created.id }, { status: 201 })
    })
}
