import { z } from 'zod'
import { desktopScreenFinishTakeover, desktopScreenStatus, desktopScreenStop, desktopScreenTakeover, desktopScreenTicket, type DesktopScreenStatus } from '@/lib/desktop/server/screen/service'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'

const takeoverUrl = z.string().url().refine(url => /^https?:\/\//i.test(url), 'Only a web page can be opened')

const postInput = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('view'), mode: z.enum(['watch', 'drive']), lease: z.string().min(1).max(500).optional() }),
    z.strictObject({ action: z.literal('takeover'), url: takeoverUrl.optional() }),
    z.strictObject({ action: z.literal('takeover-finish'), lease: z.string().min(1).max(500) }),
    z.strictObject({ action: z.literal('stop') }),
])

type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const status: DesktopScreenStatus = await desktopScreenStatus(runtime, (await params).agentId, request.signal)
        return Response.json(status, { headers: { 'cache-control': 'no-store' } })
    })
}

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const parsed = postInput.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Unknown screen request')
        const agentId = (await params).agentId
        const input = parsed.data
        switch (input.action) {
            case 'view': {
                const { socketUrl, ticket } = await desktopScreenTicket(runtime, agentId, input.mode, request.signal, input.lease)
                return Response.json({ socketUrl, expiresAt: ticket.expiresAt, width: ticket.width, height: ticket.height }, { headers: { 'cache-control': 'no-store' } })
            }
            case 'takeover': {
                const takeover = await desktopScreenTakeover(runtime, agentId, request.signal, input.url)
                return Response.json(takeover, { headers: { 'cache-control': 'no-store' } })
            }
            case 'takeover-finish': {
                const result = await desktopScreenFinishTakeover(runtime, agentId, input.lease, request.signal)
                return Response.json(result, { headers: { 'cache-control': 'no-store' } })
            }
            case 'stop': {
                await desktopScreenStop(runtime, agentId, request.signal)
                return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
            }
        }
    })
}
