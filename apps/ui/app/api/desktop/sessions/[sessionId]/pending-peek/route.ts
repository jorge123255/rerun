import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopPendingPeek } from '@/lib/desktop/server/pending-peek'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ sessionId: string }> }

// What this conversation waits on, for the inbox and General's thread rows (upstream #272). Read
// only: answering still goes through the questions and approvals routes, with their checks.
export async function GET(request: Request, { params }: Params): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopPendingPeek(runtime, (await params).sessionId, request.signal), { headers: { 'cache-control': 'no-store' } }))
}
