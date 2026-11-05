import { decideDesktopBrainProposalView, readDesktopBrainDecisionBody } from '@/lib/desktop/server/brain-proposals'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Record a dismissal. The page is left unchanged. */
export function POST(request: Request, context: { params: Promise<{ proposalId: string }> }) {
    return desktopRoute(request, async runtime => {
        const { proposalId } = await context.params
        const body = await readDesktopBrainDecisionBody(request)
        const decision = await decideDesktopBrainProposalView(runtime, proposalId, 'dismiss', body, { signal: request.signal })
        return Response.json(decision, { headers: { 'cache-control': 'no-store' } })
    })
}
