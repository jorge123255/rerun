import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopTurnRunning, stopDesktopTurn } from '@/lib/desktop/server/stop-turn'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ sessionId: string }> }

// Whether this conversation has an engine run in flight (so a reopened chat can still offer Stop).
export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopTurnRunning(runtime, (await params).sessionId), { headers: { 'cache-control': 'no-store' } }))
}

// Cancel the exact reply shown when Stop was clicked.
export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const sessionId = (await params).sessionId
        const [runId, ...duplicates] = new URL(request.url).searchParams.getAll('runId')
        if (!runId || duplicates.length || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new DesktopHttpError(400, 'A reply is required to stop this conversation.')
        return Response.json(await stopDesktopTurn(runtime, sessionId, runId))
    })
}
