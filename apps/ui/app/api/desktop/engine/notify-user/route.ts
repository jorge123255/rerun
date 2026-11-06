import { authenticateDesktopEngineRequest } from '@/lib/desktop/server/auth'
import { desktopNotifyUserReceiptSchema } from '../../../../../../../engine/src/desktop/notify-tools/contract'

export const dynamic = 'force-dynamic'

const admission = {
    notificationId: (value: unknown) => typeof value === 'string' && value.length >= 8 && value.length <= 600,
    eventKey: (value: unknown) => typeof value === 'string' && value.length >= 8 && value.length <= 600,
    agentId: (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128,
    sessionId: (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128,
    message: (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 16_000,
}

/** Does not mark a notification shown. The existing toast path is not proof of native delivery. */
export async function POST(request: Request): Promise<Response> {
    await authenticateDesktopEngineRequest(request)
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || !admission.notificationId(body.notificationId) || !admission.eventKey(body.eventKey) || !admission.agentId(body.agentId) || !admission.sessionId(body.sessionId) || !admission.message(body.message)) {
        return Response.json({ error: 'Notification identity is unavailable.' }, { status: 400, headers: { 'cache-control': 'no-store' } })
    }
    const receipt = desktopNotifyUserReceiptSchema.parse({
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
    return Response.json(receipt, { headers: { 'cache-control': 'no-store' } })
}
