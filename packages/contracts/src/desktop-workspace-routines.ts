import { z } from 'zod'

const id = z.string().min(1).max(160)
const revision = z.string().min(1).max(256)

export const desktopWorkspaceRoutineChatSchema = z.object({
    agentId: id,
    sessionId: id,
    engineSessionId: id,
    tabUid: id,
    title: z.string().max(160),
    runId: id.nullable(),
}).strict()
export type DesktopWorkspaceRoutineChat = z.infer<typeof desktopWorkspaceRoutineChatSchema>

export const desktopScheduleRecordSchema = z.object({
    agentId: id,
    slug: id,
    name: z.string().min(1).max(120),
    description: z.string().max(4000),
    body: z.string().min(1).max(64000),
    cron: z.string().max(120).nullable(),
    runAt: z.string().nullable(),
    timezone: z.string().min(1).max(100),
    enabled: z.boolean(),
    revision: revision,
    lastRunAt: z.string().nullable().optional(),
}).strict()
export type DesktopScheduleRecord = z.infer<typeof desktopScheduleRecordSchema>

export const desktopScheduledRunSchema = z.object({
    id: id,
    agentId: id,
    sessionId: id,
    triggerSource: z.string(),
    triggerSlug: id.nullable(),
    status: z.string().max(64),
    startedAt: z.string().max(64),
}).strict()
export type DesktopScheduledRun = z.infer<typeof desktopScheduledRunSchema>

export const desktopWorkspaceRoutineSchema = desktopScheduleRecordSchema.extend({
    agentId: id,
    slug: id,
    name: z.string().min(1).max(120),
    enabled: z.boolean(),
    revision: revision,
    frequency: z.string().max(500),
    nextRunAt: z.string().nullable(),
    runningSince: z.string().nullable(),
    setupPending: z.boolean(),
    lastRunAt: z.string().nullable().optional(),
    lastResult: z.object({ status: z.string().max(64), runId: id, chat: desktopWorkspaceRoutineChatSchema }).strict().optional(),
}).strict()
export type DesktopWorkspaceRoutine = z.infer<typeof desktopWorkspaceRoutineSchema>

export const desktopWorkspaceRoutinesViewSchema = z.object({
    routines: z.array(desktopWorkspaceRoutineSchema).max(1000),
    canRename: z.boolean(),
}).strict()
export type DesktopWorkspaceRoutinesView = z.infer<typeof desktopWorkspaceRoutinesViewSchema>

export const desktopWorkspaceRoutineOwnerSchema = z.object({
    agentId: id,
    engineAgentId: id,
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    setupPending: z.boolean(),
}).strict()
export type DesktopWorkspaceRoutineOwner = z.infer<typeof desktopWorkspaceRoutineOwnerSchema>

export const desktopScheduleEditInputSchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(4000),
    body: z.string().trim().min(1).max(64000),
    cron: z.string().max(120).nullable(),
    runAt: z.string().datetime({ offset: true }).nullable(),
    timezone: z.string().min(1).max(100),
    enabled: z.boolean(),
}).strict().superRefine((value, context) => {
    if (Boolean(value.cron) === Boolean(value.runAt)) context.addIssue({ code: 'custom', message: 'Choose either a recurring cron or a one-shot time.' })
})
export type DesktopScheduleEditInput = z.infer<typeof desktopScheduleEditInputSchema>

const mutationIdentity = { agentId: id, slug: id, expectedRevision: revision, requestId: z.string().uuid() }
export const desktopWorkspaceRoutineMutationSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('rename'), ...mutationIdentity, name: z.string().trim().min(1).max(120) }).strict(),
    z.object({ action: z.literal('toggle'), ...mutationIdentity, enabled: z.boolean() }).strict(),
    z.object({ action: z.literal('run'), ...mutationIdentity }).strict(),
    z.object({ action: z.literal('edit'), ...mutationIdentity, input: desktopScheduleEditInputSchema }).strict(),
])
export type DesktopWorkspaceRoutineMutation = z.infer<typeof desktopWorkspaceRoutineMutationSchema>
export const desktopWorkspaceRoutineMutationResultSchema = z.object({
    routine: desktopWorkspaceRoutineSchema,
    chat: desktopWorkspaceRoutineChatSchema.optional(),
}).strict()
export type DesktopWorkspaceRoutineMutationResult = z.infer<typeof desktopWorkspaceRoutineMutationResultSchema>

export function byNextRun(a: Pick<DesktopWorkspaceRoutine, 'nextRunAt' | 'name'>, b: Pick<DesktopWorkspaceRoutine, 'nextRunAt' | 'name'>): number {
    if (a.nextRunAt === b.nextRunAt) return a.name.localeCompare(b.name)
    if (!a.nextRunAt) return 1
    if (!b.nextRunAt) return -1
    return a.nextRunAt.localeCompare(b.nextRunAt)
}
