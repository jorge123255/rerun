import { createDesktopCoworkerMentionsApi } from '@/lib/desktop/server/coworker-mentions'
import { desktopCoworkerMentionTargets } from '@/lib/desktop/server/engine'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async runtime => {
        const api = createDesktopCoworkerMentionsApi({
            listTargets: ownerAgentId => desktopCoworkerMentionTargets(runtime, ownerAgentId),
        })
        return api(request, (await params).agentId)
    })
}
