import { authenticateDesktopEngineRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { desktopNotifyUserReceiptSchema } from '../../../../../../engine/src/desktop/notify-tools/contract'

export const dynamic = 'force-dynamic'

const headers = { 'cache-control': 'no-store' }

/** Does not mark a notification shown. The existing toast path is not proof of native delivery. */
export async function POST(request: Request): Promise<Response> {
    try {
        await authenticateDesktopEngineRequest(request)
        const input = await readDesktopJson(request, 200_000)
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DesktopHttpError(400, 'Notification identity is unavailable.')
        const body = input as Record<string, unknown>
        const receipt = desktopNotifyUserReceiptSchema.safeParse({
            notificationId: body.notificationId,
            eventKey: body.eventKey,
            attemptId: crypto.randomUUID(),
            agentId: body.agentId,
            sessionId: body.sessionId,
            runId: typeof body.runId === 'string' ? body.runId : null,
            message: body.message,
            metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : null,
            status: 'unknown',
            nativeStatus: 'unknown',
            reason: 'Native delivery was not confirmed. This attempt was not retried.',
            createdAt: new Date().toISOString(),
        })
        if (!receipt.success) throw new DesktopHttpError(400, 'Notification identity is unavailable.')
        return Response.json(receipt.data, { headers })
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ error: error.message }, { status: error.status, headers })
        return Response.json({ error: 'Desktop callback failed' }, { status: 500, headers })
    }
}
