import 'server-only'
import { engineCreatedEventSchema, notificationPayloadSchema } from '@/lib/engine/types'
import { authenticateDesktopEngineRequest, DesktopHttpError } from './auth'

const SUPPORTED_CREATED_EVENTS = new Set(['box.connection.connected'])
const SUPPORTED_NOTIFICATION_EVENTS = new Set(['agent.message.completed'])

export async function handleDesktopEngineCallback(request: Request): Promise<Response> {
    try {
        await authenticateDesktopEngineRequest(request)
        const body = await request.json().catch(() => undefined)
        if (body === undefined) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

        const created = engineCreatedEventSchema.safeParse(body)
        if (created.success) {
            if (SUPPORTED_CREATED_EVENTS.has(created.data.event)) return Response.json({ ok: true, persisted: false }, { status: 202 })
            return Response.json({ ok: true, ignored: 'unsupported_m1_event', persisted: false }, { status: 202 })
        }

        const notification = notificationPayloadSchema.safeParse(body)
        if (!notification.success) return Response.json({ error: 'Invalid payload' }, { status: 400 })
        if (SUPPORTED_NOTIFICATION_EVENTS.has(notification.data.event)) return Response.json({ ok: true, persisted: false }, { status: 202 })
        return Response.json({ ok: true, ignored: 'unsupported_m1_event', persisted: false }, { status: 202 })
    } catch (error) {
        if (error instanceof DesktopHttpError) return Response.json({ error: error.message }, { status: error.status })
        return Response.json({ error: 'Desktop callback failed' }, { status: 500 })
    }
}
