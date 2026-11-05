import 'server-only'
import { engineCreatedEventSchema, notificationPayloadSchema } from '@/lib/engine/types'
import { authenticateDesktopEngineRequest, DesktopHttpError } from './auth'
import { recordDesktopRunTerminal } from './notifications'
import { handleDesktopScheduleBridge } from './schedules-binding'
import { adoptDesktopScheduleEvent } from './schedules/adoption'
import { openDesktopDatabase } from './database'
import { engineOf } from './settings'

const SUPPORTED_CREATED_EVENTS = new Set(['box.connection.connected'])
const SUPPORTED_NOTIFICATION_EVENTS = new Set(['agent.message.completed', 'agent.schedule.completed', 'agent.trigger.completed'])

export async function handleDesktopEngineCallback(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const body = await request.json().catch(() => undefined)
        if (body === undefined) return Response.json({ error: 'Invalid JSON' }, { status: 400 })
        const scheduleResponse = await handleDesktopScheduleBridge(runtime, body, request.signal)
        if (scheduleResponse) return scheduleResponse

        const created = engineCreatedEventSchema.safeParse(body)
        if (created.success) {
            if (SUPPORTED_CREATED_EVENTS.has(created.data.event)) return Response.json({ ok: true, persisted: false }, { status: 202 })
            return Response.json({ ok: true, ignored: 'unsupported_m1_event', persisted: false }, { status: 202 })
        }

        const notification = notificationPayloadSchema.safeParse(body)
        if (!notification.success) return Response.json({ error: 'Invalid payload' }, { status: 400 })
        if (!SUPPORTED_NOTIFICATION_EVENTS.has(notification.data.event)) return Response.json({ ok: true, ignored: 'unsupported_m1_event', persisted: false }, { status: 202 })
        if (notification.data.event === 'agent.schedule.completed' && notification.data.agentId) {
            await adoptDesktopScheduleEvent(await openDesktopDatabase(runtime.dataRoot), engineOf(runtime), {
                agentId: notification.data.agentId, sessionId: notification.data.sessionId, runId: notification.data.runId,
            })
        }
        // Only cancelled/error terminals persist here; a genuine `done` stays on the completion
        // store the finished-run cards already read, so nothing announces twice.
        const persisted = await recordDesktopRunTerminal(runtime, notification.data)
        return Response.json({ ok: true, persisted }, { status: 202 })
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ error: error.message }, { status: error.status })
        return Response.json({ error: 'Desktop callback failed' }, { status: 500 })
    }
}
