import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopTurnRunning, stopDesktopTurn } from '@/lib/desktop/server/stop-turn'
import { withDesktopSecretSessionTransition } from '@/lib/desktop/server/secret-requests/lifecycle'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ sessionId: string }> }

// Whether this conversation has an engine run in flight (so a reopened chat can still offer Stop).
export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopTurnRunning(runtime, (await params).sessionId), { headers: { 'cache-control': 'no-store' } }))
}

// Cancel the engine run(s) generating a reply in this conversation.
export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const sessionId = (await params).sessionId
        return Response.json(await withDesktopSecretSessionTransition(runtime, sessionId, () => stopDesktopTurn(runtime, sessionId)))
    })
}
