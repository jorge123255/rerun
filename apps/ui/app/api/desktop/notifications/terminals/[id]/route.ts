import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopTerminalBinding } from '@/lib/desktop/server/notifications'

export const dynamic = 'force-dynamic'

// The click revalidation for a stopped or failed run: the recorded terminal re-mapped onto the
// current local coworker and conversation. Anything gone resolves to a 404 and the click lands
// nowhere — never a blind navigation.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const { id } = await params
        const binding = await readDesktopTerminalBinding(await openDesktopDatabase(runtime.dataRoot), id)
        if (!binding) return Response.json({ error: 'That notification is no longer available.' }, { status: 404, headers: { 'cache-control': 'no-store' } })
        return Response.json(binding, { headers: { 'cache-control': 'no-store' } })
    })
}
