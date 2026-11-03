import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'
import { clearDesktopReplyFeedback, desktopReplyDetailsSchema, desktopReplyRateSchema, listDesktopReplyFeedback, rateDesktopReply, updateDesktopReplyDetails } from '@/lib/desktop/server/reply-feedback'
import { z } from 'zod'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ sessionId: string }> }
const noStore = { 'cache-control': 'no-store' }

function agentIdOf(value: string | null): string {
    const parsed = z.string().uuid().safeParse(value)
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid feedback')
    return parsed.data
}

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { sessionId } = await params
        const agentId = agentIdOf(new URL(request.url).searchParams.get('agentId'))
        const db = await openDesktopDatabase(runtime.dataRoot)
        return Response.json({ votes: await listDesktopReplyFeedback(db, agentId, sessionId) }, { headers: noStore })
    })
}

export function PUT(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const body = desktopReplyRateSchema.safeParse(await request.json().catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Invalid feedback')
        const { sessionId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        const vote = await rateDesktopReply(db, runtime, sessionId, body.data)
        return Response.json(vote, { headers: noStore })
    })
}

export function PATCH(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const body = desktopReplyDetailsSchema.safeParse(await request.json().catch(() => null))
        if (!body.success) throw new DesktopHttpError(400, 'Invalid feedback')
        const { sessionId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        await updateDesktopReplyDetails(db, runtime, sessionId, body.data)
        return Response.json({ ok: true }, { headers: noStore })
    })
}

export function DELETE(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const url = new URL(request.url)
        const { sessionId } = await params
        const db = await openDesktopDatabase(runtime.dataRoot)
        await clearDesktopReplyFeedback(db, agentIdOf(url.searchParams.get('agentId')), sessionId, url.searchParams.get('id') ?? '')
        return Response.json({ ok: true }, { headers: noStore })
    })
}
