import { readDesktopCompletions } from '@/lib/desktop/server/completed-actions'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

// Bounded read-only: the finished-run cards, never a full history scan. `limit` clamps server-side
// and `before` is the stable (completed_at, id) cursor the projection returns as `nextCursor`.
export async function GET(request: Request): Promise<Response> {
    return desktopRoute(request, async runtime => {
        const url = new URL(request.url)
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
        const before = url.searchParams.get('before') ?? undefined
        const result = await readDesktopCompletions(runtime, {
            ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
            ...(before ? { before } : {}),
        })
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    })
}
