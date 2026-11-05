import { decideDesktopBrainProposalView } from '@/lib/desktop/server/brain-proposals'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Record an acceptance. This does not write the brain page. */
export function POST(request: Request, context: { params: Promise<{ proposalId: string }> }) {
    return desktopRoute(request, async runtime => {
        const { proposalId } = await context.params
        const body = await request.json().catch(() => ({}))
        const decision = await decideDesktopBrainProposalView(runtime, proposalId, 'accept', body, { signal: request.signal })
        return Response.json(decision, { headers: { 'cache-control': 'no-store' } })
    })
}
