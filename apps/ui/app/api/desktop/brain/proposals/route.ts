import { desktopBrainProposalStatus, listDesktopBrainProposalViews } from '@/lib/desktop/server/brain-proposals'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Workspace company-brain proposals. A failed read is an error, not an empty list. */
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const status = desktopBrainProposalStatus(new URL(request.url).searchParams.get('status'))
        const proposals = await listDesktopBrainProposalViews(runtime, status, { signal: request.signal })
        return Response.json({ proposals }, { headers: { 'cache-control': 'no-store' } })
    })
}
