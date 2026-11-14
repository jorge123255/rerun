import { readDesktopSharedFile } from '@/lib/desktop/server/shared-workspace-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** One bounded editor text page from the workspace shared folder. */
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const offset = query.has('offset') ? Number(query.get('offset')) : 0
        const page = await readDesktopSharedFile(runtime, query.get('path') ?? '', offset, { signal: request.signal })
        return Response.json(page, { headers: { 'cache-control': 'no-store' } })
    })
}
