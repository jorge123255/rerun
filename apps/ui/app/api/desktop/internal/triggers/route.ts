import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopTriggerBody } from '@/lib/desktop/server/triggers/api'
import { handleDesktopTriggerBridge } from '@/lib/desktop/server/triggers/binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        return await handleDesktopTriggerBridge(runtime, await readDesktopTriggerBody(request), request.signal) ?? Response.json({ error: 'Unknown trigger callback' }, { status: 400 })
    } catch (error) { return Response.json({ error: error instanceof DesktopHttpError ? error.message : 'Trigger callback failed' }, { status: error instanceof DesktopHttpError ? error.status : 400 }) }
}
