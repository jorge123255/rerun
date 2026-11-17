import { z } from 'zod'

// A coworker's scheduled tasks and triggers as one list, the way the web's Routines tile groups them.
export const routineKindSchema = z.enum(['schedule', 'trigger'])
export type RoutineKind = z.infer<typeof routineKindSchema>

// `cronLabel` is the cron already put in words by the hub; `runAt` is left as an instant so the phone
// shows it in its own time zone. A trigger has neither: it fires on its webhook.
export const routineViewSchema = z.object({
    kind: routineKindSchema,
    slug: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    cronLabel: z.string().nullable(),
    runAt: z.string().nullable(),
    timezone: z.string().nullable(),
})
export type RoutineView = z.infer<typeof routineViewSchema>

export const routinesViewSchema = z.object({ routines: z.array(routineViewSchema) })
export type RoutinesView = z.infer<typeof routinesViewSchema>

export const updateRoutineSchema = z.object({ enabled: z.boolean() })
export type UpdateRoutineInput = z.infer<typeof updateRoutineSchema>
