import { readDesktopPendingInbox } from '@/lib/desktop/server/pending-inbox'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

// The pending actions list with the inbox's own durable read receipts subtracted. A read receipt
// never answers, approves or executes the request: the chat cards and the board keep showing it.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => Response.json(await readDesktopPendingInbox(runtime), { headers: { 'cache-control': 'no-store' } }))
}
