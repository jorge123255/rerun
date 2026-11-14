import { foremanBindingSchema } from '@rerun/contracts'
import { z } from 'zod'

// A wake-up for the authenticated state read. It carries no preview or action.
export const desktopForemanReplyChangedSchema = z.strictObject({
    type: z.literal('reply-changed'),
    binding: foremanBindingSchema,
})
export type DesktopForemanReplyChanged = z.infer<typeof desktopForemanReplyChangedSchema>

export const DESKTOP_FOREMAN_LIVE_REPLY_LIMIT = 24_000
export const DESKTOP_FOREMAN_LIVE_STEP_LIMIT = 48

// These read-only steps can be described without arguments, result details or action affordances.
export const desktopForemanLiveToolSchema = z.enum([
    'search_docs', 'read_company', 'agent_files_list', 'agent_files_read', 'agent_files_search',
    'list_spaces', 'list_agents', 'list_schedules', 'list_triggers',
])
const liveStepSchema = z.strictObject({
    tool: desktopForemanLiveToolSchema,
    offset: z.number().int().min(0).max(DESKTOP_FOREMAN_LIVE_REPLY_LIMIT),
    status: z.enum(['running', 'done', 'error']),
})
export type DesktopForemanLiveStep = z.infer<typeof liveStepSchema>

export const desktopForemanLiveReplySchema = z.strictObject({
    runId: z.string().min(1).max(128),
    text: z.string().max(DESKTOP_FOREMAN_LIVE_REPLY_LIMIT),
    steps: z.array(liveStepSchema).min(1).max(DESKTOP_FOREMAN_LIVE_STEP_LIMIT).optional(),
}).refine(({ text, steps }) => (!!text.trim() || !!steps?.length)
    && (!steps || steps.every((step, index) => step.offset <= text.length && step.offset >= (steps[index - 1]?.offset ?? 0))))
export type DesktopForemanLiveReply = z.infer<typeof desktopForemanLiveReplySchema>
