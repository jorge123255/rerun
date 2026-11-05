import { notificationPrefsPatchSchema } from '@rerun/contracts'
import { z } from 'zod'

// The desktop notification contract: the original scope/channel/coworker preferences stored on
// this Mac, plus the events a mounted delivery announces through the root-reviewed native bridge.

export const DESKTOP_NOTIFICATION_PREFS_URL = '/api/desktop/notifications'
export const DESKTOP_NOTIFICATION_EVENTS_URL = '/api/desktop/notifications/events'
export const DESKTOP_NOTIFICATION_SEEN_URL = '/api/desktop/notifications/seen'

// The original patch shape the settings surface sends; the stored value merges it exactly like
// the hosted write did.
export const desktopNotificationPrefsPatchSchema = notificationPrefsPatchSchema

export const desktopNotificationEventSchema = z.object({
    key: z.string().min(1),
    kind: z.enum(['done', 'question', 'approval']),
    agentId: z.string().min(1),
    agentName: z.string(),
    sessionId: z.string().min(1),
    title: z.string(),
    subtitle: z.string(),
    body: z.string().nullable(),
    silent: z.boolean(),
    // The revalidation identity: the finished-run group for `done`, the exact pending request
    // hash for a question or approval.
    groupId: z.string().optional(),
    requestId: z.string().optional(),
})
export type DesktopNotificationEvent = z.infer<typeof desktopNotificationEventSchema>

export const desktopNotificationChannelsSchema = z.object({ toast: z.boolean(), sound: z.boolean() })
export const desktopNotificationEventsSchema = z.object({
    events: z.array(desktopNotificationEventSchema),
    channels: desktopNotificationChannelsSchema,
    unavailableAgentIds: z.array(z.string()),
    checkedAt: z.string(),
})
export type DesktopNotificationEvents = z.infer<typeof desktopNotificationEventsSchema>
