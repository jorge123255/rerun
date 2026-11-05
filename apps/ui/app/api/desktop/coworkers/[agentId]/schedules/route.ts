import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopScheduleRequest } from '@/lib/desktop/server/schedules-binding'

type Context = { params: Promise<{ agentId: string }> }
function handle(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => desktopScheduleRequest(runtime, request, (await params).agentId))
}
export const GET = handle
export const PUT = handle
export const POST = handle
export const DELETE = handle
