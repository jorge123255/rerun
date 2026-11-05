import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopTriggerRequest } from '@/lib/desktop/server/triggers'

type Context = { params: Promise<{ agentId: string }> }

function handle(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => desktopTriggerRequest(runtime, request, (await params).agentId))
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = handle
export const PUT = handle
export const POST = handle
export const DELETE = handle
