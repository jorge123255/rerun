import { notificationPrefsPatchSchema } from '@rerun/contracts'
import { z } from 'zod'

// The desktop notification contract: the original scope/channel/coworker preferences stored on
// this Mac, plus the events a mounted delivery announces through the root-reviewed native bridge.

export const DESKTOP_NOTIFICATION_PREFS_URL = '/api/desktop/notifications'
export const DESKTOP_NOTIFICATION_EVENTS_URL = '/api/desktop/notifications/events'
export const DESKTOP_NOTIFICATION_SEEN_URL = '/api/desktop/notifications/seen'
export const DESKTOP_NOTIFICATION_ADMIT_URL = '/api/desktop/notifications/admit'
export const DESKTOP_NOTIFICATION_DELIVERY_URL = '/api/desktop/notifications/delivery'
export const DESKTOP_NOTIFICATION_TERMIALS_URL = '/api/desktop/notifications/terminals'

// The original patch shape the settings surface sends; the stored value merges it exactly like
// the hosted write did.
export const desktopNotificationPrefsPatchSchema = notificationPrefsPatchSchema

export const desktopNotificationEventSchema = z.object({
    key: z.string().min(1),
    kind: z.enum(['done', 'error', 'question', 'approval', 'takeover', 'service', 'secret', 'mcp', 'tool-install']),
    source: z.enum(['chat', 'schedule', 'trigger']),
    agentId: z.string().min(1),
    agentName: z.string(),
    sessionId: z.string().min(1),
    title: z.string(),
    subtitle: z.string(),
    body: z.string().nullable(),
    silent: z.boolean(),
    // The revalidation identity: the finished-run group for a completion, the recorded terminal
    // for a failed run, the exact pending request hash for a question or approval.
    groupId: z.string().optional(),
    terminalId: z.string().optional(),
    requestId: z.string().optional(),
})
export type DesktopNotificationEvent = z.infer<typeof desktopNotificationEventSchema>

export const desktopNotificationStatusSchema = z.enum(['shown', 'unavailable', 'failed', 'unknown'])
export const desktopNotificationReceiptSchema = z.strictObject({
    key: z.string().min(8).max(600),
    attemptId: z.string().uuid(),
    status: desktopNotificationStatusSchema,
    nativeStatus: desktopNotificationStatusSchema.nullable().optional(),
})
export type DesktopNotificationReceipt = z.infer<typeof desktopNotificationReceiptSchema>

export const desktopNotificationChannelsSchema = z.object({ toast: z.boolean(), sound: z.boolean() })
export const desktopNotificationEventsSchema = z.object({
    events: z.array(desktopNotificationEventSchema),
    channels: desktopNotificationChannelsSchema,
    unavailableAgentIds: z.array(z.string()),
    checkedAt: z.string(),
})
export type DesktopNotificationEvents = z.infer<typeof desktopNotificationEventsSchema>
export const desktopNotificationAdmissionsSchema = z.object({
    events: z.array(desktopNotificationEventSchema.extend({ attemptId: z.string().uuid() })).max(50),
    channels: desktopNotificationChannelsSchema,
})

// What a terminal click revalidates to: the current local owner and conversation of the recorded
// run, resolved live so a deleted coworker or rebound session lands nowhere.
export const desktopTerminalBindingSchema = z.object({ agentId: z.string().min(1), sessionId: z.string().min(1) })
export type DesktopNotificationAdmission = z.infer<typeof desktopNotificationAdmissionsSchema>['events'][number]
export type DesktopTerminalBinding = z.infer<typeof desktopTerminalBindingSchema>
