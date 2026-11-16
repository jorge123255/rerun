import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { startDesktopChat } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'
import { cancelDesktopUsageWait, flushDesktopUsageWaits, listDesktopUsageWaitKeys, queueDesktopUsageWait, readDesktopUsageWait } from '@/lib/desktop/server/usage-waits'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const id = z.string().min(1).max(200)
const action = z.discriminatedUnion('action', [
    z.object({ action: z.literal('queue'), agentId: id, sessionId: id.nullable(), text: z.string().min(1).max(20_000) }).strict(),
    z.object({ action: z.literal('cancel'), id: z.string().uuid() }).strict(),
    z.object({ action: z.literal('flush') }).strict(),
])

// What this conversation is waiting for: the queued message, and the plan with its reset time.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const agentId = id.safeParse(query.get('agentId')), sessionId = id.nullable().safeParse(query.get('sessionId'))
        if (!agentId.success || !sessionId.success) throw new DesktopHttpError(400, 'Choose a conversation.')
        return Response.json(await readDesktopUsageWait(runtime, agentId.data, sessionId.data), { headers })
    })
}

export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = action.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Invalid request.')
        const input = parsed.data
        if (input.action === 'queue') return Response.json(await queueDesktopUsageWait(runtime, input), { headers })
        if (input.action === 'cancel') return Response.json({ cancelled: await cancelDesktopUsageWait(runtime, input.id) }, { headers })
        const sent = await flushDesktopUsageWaits(runtime, (target, message) => startDesktopChat(target, message))
        return Response.json({ sent, active: await listDesktopUsageWaitKeys(runtime) }, { headers })
    })
}
