import { desktopRoute } from '@/lib/desktop/server/http'
import { handleDesktopResultFilePost } from '@/lib/desktop/server/result-files/handler'
import { localResultFileAuthority } from '@/lib/desktop/server/result-files/authority'

export const dynamic = 'force-dynamic'
export function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async runtime => handleDesktopResultFilePost(runtime, (await params).agentId, request, localResultFileAuthority))
}
