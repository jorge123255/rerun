import { z } from 'zod'

/** Separate from the Schedules grant, which only runs routines. A separate, default-off capability in the desktop grant catalog. */
export const DESKTOP_SCHEDULE_MANAGE_GRANT_ID = 'scheduleManage' as const

export const DESKTOP_SCHEDULE_TOOL_NAMES = ['schedule_list', 'schedule_get', 'schedule_create', 'schedule_update', 'schedule_edit', 'schedule_delete'] as const
export type DesktopScheduleToolName = (typeof DESKTOP_SCHEDULE_TOOL_NAMES)[number]

export const desktopScheduleToolOutcomeSchema = z.enum(['committed', 'rejected', 'cancelled', 'uncertain'])
export type DesktopScheduleToolOutcome = z.infer<typeof desktopScheduleToolOutcomeSchema>

export const desktopScheduleToolOperationSchema = z.enum(['list', 'get', 'create', 'update', 'edit', 'delete'])
export type DesktopScheduleToolOperation = z.infer<typeof desktopScheduleToolOperationSchema>

export const DESKTOP_SCHEDULE_TOOL_MESSAGES = {
    unwired: 'Schedule management is not wired on this Mac yet.',
    permission: 'Schedule management is turned off for this coworker.',
    disabled: 'Enable this coworker to manage routines.',
    deleting: 'Coworker identity changed.',
    setup: 'Finish guided setup before managing routines.',
    inactive: 'Schedule run is no longer active.',
    invocation: 'Schedule mutation requires a trusted tool invocation.',
    listUnavailable: 'Scheduled tasks could not be read.',
    fileUnsafe: 'Schedule file is not a regular file.',
    cancelled: 'Schedule change cancelled.',
    uncertain: 'Schedule change was not acknowledged. Retry the same change.',
    stale: 'Schedule changed since you read it. Call schedule_get and retry. The previous routine was kept.',
    conflict: 'This request belongs to a different schedule change.',
    interrupted: 'This earlier change was interrupted. Reopen the routine and make a new change.',
    pending: 'Another schedule change is awaiting acknowledgement. Retry that change first.',
    replaced: 'Schedule was replaced while its change was pending. The previous routine was kept.',
    exists: 'A schedule with this name already exists. Use schedule_update or schedule_edit.',
    noModel: 'This coworker has no connected model, so a routine cannot be saved to run later.',
    timezone: 'Timezone is required. Use an IANA name such as Europe/Paris.',
    exclusive: 'Provide exactly one of cron or runAt.',
    neither: 'Provide either cron (recurring) or runAt (one-shot).',
    both: 'Provide only one of cron or runAt, not both.',
    providerWithoutModel: 'provider only goes with a model; nothing changed.',
    identical: 'oldString and newString are identical; nothing to do.',
    emptyExcerpt: 'oldString must be a non-empty excerpt.',
    name: 'Schedule name must contain a letter or digit.',
    tooLong: 'Task instruction is too long.',
    empty: 'No scheduled tasks yet.',
    notFound: (slug: string) => `Schedule not found: ${slug}`,
    invalidTimezone: (value: string) => `Invalid timezone: ${value}`,
    invalidCron: (value: string) => `Invalid cron expression: ${value}`,
    invalidRunAt: (value: string) => `Invalid runAt timestamp: ${value}`,
    pinIgnored: (current: string) => `Desktop routines run on this coworker's connected model (${current}). A different pin would be ignored, so nothing was saved.`,
    missingExcerpt: (slug: string) => `oldString not found in ${slug}. Call schedule_get to read the current body, then retry with an exact excerpt of it. Never fall back to rewriting the whole body from memory.`,
    ambiguous: (slug: string, count: number) => `oldString matches ${count} times in ${slug}; pass replaceAll or provide a more specific string.`,
    created: (slug: string) => `Created schedule ${slug}`,
    updated: (slug: string) => `Updated schedule ${slug}`,
    replacedBody: (slug: string, before: number, after: number) => `Updated schedule ${slug} (body replaced: ${before} → ${after} chars)`,
    edited: (slug: string, count: number) => `Edited schedule ${slug} (${count} replacement${count === 1 ? '' : 's'})`,
    deleted: (slug: string) => `Deleted schedule ${slug}`,
} as const

export const desktopScheduleToolNoticeSchema = z.object({
    localAgentId: z.string().min(1).max(200),
    engineAgentId: z.string().min(1).max(200),
    slug: z.string().min(1).max(160),
    operation: z.enum(['create', 'update', 'edit', 'delete']),
    outcome: z.literal('committed'),
    revision: z.string().min(1).max(128),
    at: z.string().min(1).max(64),
}).strict()
export type DesktopScheduleToolNotice = z.infer<typeof desktopScheduleToolNoticeSchema>

export const desktopScheduleToolProjectionSchema = z.object({
    outcome: desktopScheduleToolOutcomeSchema,
    operation: desktopScheduleToolOperationSchema,
    text: z.string(),
    slug: z.string().nullable(),
    revision: z.string().nullable(),
}).strict()
export type DesktopScheduleToolProjection = z.infer<typeof desktopScheduleToolProjectionSchema>
