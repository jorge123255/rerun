import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { withCoworkerMemories } from '@/lib/desktop/server/memories'
import { deleteMemory } from '@/lib/engine/client'

export function DELETE(request: Request, { params }: { params: Promise<{ agentId: string; memoryId: string }> }) {
    return desktopRoute(request, async runtime => {
        const { agentId, memoryId } = await params
        if (!/^[a-zA-Z0-9_-]+$/.test(memoryId) || memoryId === 'recall') throw new DesktopHttpError(400, 'Invalid memory ID.')
        await withCoworkerMemories(runtime, agentId, (engine, id) => deleteMemory(engine, id, memoryId))
        return new Response(null, { status: 204 })
    })
}
