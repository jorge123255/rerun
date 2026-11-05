import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopCoworkerCalls, stopDesktopCoworkerCall } from '@/lib/desktop/server/coworker-calls/http'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopCoworkerCalls(runtime, (await params).sessionId), { headers: { 'cache-control': 'no-store' } }))
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => stopDesktopCoworkerCall(runtime, (await params).sessionId, await request.json().catch(() => null)))
}
