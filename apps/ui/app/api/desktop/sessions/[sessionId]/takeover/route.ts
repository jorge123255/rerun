import { interceptDesktopWebhookDecision } from '@/lib/desktop/server/trigger-requests/binding'
import { desktopTakeoverActionSchema } from '@/lib/desktop/takeover'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { answerDesktopTakeover, readDesktopTakeover } from '@/lib/desktop/server/takeover'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopTakeover(runtime, (await params).sessionId), { headers: { 'cache-control': 'no-store' } }))
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const parsed = desktopTakeoverActionSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Open the screen, finish the takeover, or skip it.')
        const sessionId = (await params).sessionId
        if (parsed.data.action === 'done' || parsed.data.action === 'skip') {
            const linked = await interceptDesktopWebhookDecision(runtime, sessionId, { kind: 'takeover', input: parsed.data as never })
            if (linked) return linked
        }
        return answerDesktopTakeover(runtime, sessionId, parsed.data)
    })
}
