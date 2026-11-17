import { z } from 'zod'
import { providerSchema } from './agent.js'

export const scheduleSchema = z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    cron: z.string().nullable(),
    runAt: z.string().nullable(),
    timezone: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    connectionId: z.string().nullable(),
    provider: providerSchema.nullable(),
    model: z.string().nullable(),
    body: z.string().default(''),
    createdAt: z.string(),
})
export type Schedule = z.infer<typeof scheduleSchema>

export const schedulesListSchema = z.object({ schedules: z.array(scheduleSchema) })
