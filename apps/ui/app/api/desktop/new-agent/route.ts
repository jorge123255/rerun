import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { boundedText } from '@/lib/desktop/server/mcp/remote'
import { acknowledgeDesktopCreation, createDescribedDesktopCoworker, desktopCreationAck, desktopCreationRequest, hasDesktopCreationReceipt, readPendingDesktopCreation } from '@/lib/desktop/server/new-agent'
import { desktopAgentView } from '@/lib/desktop/server/views'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }

export function GET(request: Request) {
    return desktopRoute(request, async runtime => Response.json({ pending: await readPendingDesktopCreation(runtime) }, { headers }))
}
export function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const body = await boundedText(new Response(request.body), AbortSignal.any([request.signal, AbortSignal.timeout(5000)]), 32_768).catch(() => '')
        const input = desktopCreationRequest.safeParse((() => { try { return JSON.parse(body) } catch { return null } })())
        if (!input.success) return Response.json({ definite: true, code: 'creation_refused', error: 'Choose a description, name and spot on the board.' }, { status: 400, headers })
        try {
            const result = await createDescribedDesktopCoworker(runtime, input.data)
            return Response.json({ agent: desktopAgentView(result.agent), sessionId: result.sessionId }, { headers })
        } catch (error) {
            // Every failure after a durable reservation is uncertain until replay confirms both
            // the coworker and its first chat. A prior created-agent ID alone is not completion.
            const reserved = await hasDesktopCreationReceipt(runtime, input.data.intent.requestId).catch(() => true)
            if (reserved) return Response.json({ definite: false, error: 'Could not confirm creation and the first chat. Retry this saved placement.' }, { status: 503, headers })
            const definite = error instanceof DesktopHttpError && error.status < 500
            return Response.json({ definite, code: definite && error.status === 409 ? 'position_occupied' : 'creation_refused', error: definite ? error.message : 'Could not check creation. Try the same placement again.' }, { status: definite ? error.status : 503, headers })
        }
    })
}
export function PATCH(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopCreationAck.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the saved creation receipt.')
        await acknowledgeDesktopCreation(runtime, parsed.data.requestId)
        return Response.json({ acknowledged: true }, { headers })
    })
}
