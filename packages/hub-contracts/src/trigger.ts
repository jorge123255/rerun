import { z } from 'zod'
import { providerSchema } from './agent.js'

export const triggerMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
export type TriggerMethod = z.infer<typeof triggerMethodSchema>

export const triggerSchema = z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    token: z.string(),
    methods: z.array(triggerMethodSchema).default(['POST']),
    lastFiredAt: z.string().nullable(),
    fireCount: z.number().int().nonnegative().default(0),
    connectionId: z.string().nullable(),
    provider: providerSchema.nullable(),
    model: z.string().nullable(),
    body: z.string().default(''),
    createdAt: z.string(),
})
export type Trigger = z.infer<typeof triggerSchema>

export const triggersListSchema = z.object({ triggers: z.array(triggerSchema) })

export const createTriggerSchema = z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    body: z.string().min(1),
    methods: z.array(triggerMethodSchema).min(1).optional(),
    enabled: z.boolean().optional(),
    connectionId: z.string().nullable().optional(),
    // Null means "whatever the agent runs", which is itself the box default when the agent picked
    // nothing. A routine that names no model follows its agent instead of freezing a pair.
    provider: providerSchema.nullable().default(null),
    model: z.string().nullable().default(null),
})

// The slug is derived from the name and the public URL is built from the slug, so renaming
// would silently break every caller. The name is fixed at creation.
export const updateTriggerSchema = z.object({
    description: z.string().optional(),
    body: z.string().optional(),
    methods: z.array(triggerMethodSchema).min(1).optional(),
    enabled: z.boolean().optional(),
    connectionId: z.string().nullable().optional(),
    provider: providerSchema.nullable().optional(),
    model: z.string().nullable().optional(),
})

// What the UI forwards to the engine when the public URL is called. The caller's headers are
// deliberately absent: they carry credentials and are trivially spoofed.
export const triggerFireSchema = z.object({
    token: z.string().min(1),
    method: triggerMethodSchema,
    query: z.string().default(''),
    contentType: z.string().default(''),
    body: z.string().default(''),
    bodyBytes: z.number().int().nonnegative().default(0),
})
export type TriggerFireInput = z.infer<typeof triggerFireSchema>
