import { z } from 'zod'

export const memorySchema = z.object({
    id: z.string(),
    kind: z.string(),
    tags: z.array(z.string()),
    createdAt: z.string(),
    content: z.string(),
    lastAccessedAt: z.string().nullable().optional(),
    accessCount: z.number().optional(),
    strength: z.number().optional(),
    status: z.enum(['active', 'dormant']).optional(),
})
export type Memory = z.infer<typeof memorySchema>

export const memoriesListSchema = z.object({ memories: z.array(memorySchema) })
