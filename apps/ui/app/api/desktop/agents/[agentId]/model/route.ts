import { z } from 'zod'
import { desktopModelPickSchema } from '@/lib/desktop/chat-model'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopModelState, setDesktopConversationModel, setDesktopCoworkerModel } from '@/lib/desktop/server/chat-model'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

const id = z.string().trim().min(1).max(256)
const patchSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('coworker'), connectionId: id, model: id, sessionId: id.optional() }),
    z.object({ action: z.literal('follow-workspace'), sessionId: id.optional() }),
    z.object({ action: z.literal('conversation'), sessionId: id, connectionId: id, model: id }),
    z.object({ action: z.literal('conversation-follow'), sessionId: id }),
])

type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const sessionId = new URL(request.url).searchParams.get('sessionId') ?? undefined
        if (sessionId !== undefined && !id.safeParse(sessionId).success) throw new DesktopHttpError(400, 'Conversation not found')
        const state = await readDesktopModelState(runtime, agentId, sessionId)
        return Response.json(state, { headers: { 'cache-control': 'no-store' } })
    })
}

export function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const patch = patchSchema.safeParse(await request.json().catch(() => null))
        if (!patch.success) throw new DesktopHttpError(400, 'Choose a model offered by a connected provider.')
        const change = patch.data
        const state = change.action === 'coworker' ? await setDesktopCoworkerModel(runtime, agentId, desktopModelPickSchema.parse(change), change.sessionId)
            : change.action === 'follow-workspace' ? await setDesktopCoworkerModel(runtime, agentId, null, change.sessionId)
            : change.action === 'conversation' ? await setDesktopConversationModel(runtime, agentId, change.sessionId, desktopModelPickSchema.parse(change))
            : await setDesktopConversationModel(runtime, agentId, change.sessionId, null)
        return Response.json(state, { headers: { 'cache-control': 'no-store' } })
    })
}
