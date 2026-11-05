import { countOpenDesktopBrainProposals } from '@/lib/desktop/server/brain-proposals'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Open proposal count. A failure stays an error so the menu does not show zero. */
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const count = await countOpenDesktopBrainProposals(runtime, { signal: request.signal })
        return Response.json({ count }, { headers: { 'cache-control': 'no-store' } })
    })
}
