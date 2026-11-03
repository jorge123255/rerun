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

export const desktopMemoryCreateSchema = z.strictObject({
    content: z.string().trim().min(1),
    kind: z.string().trim().default('note').transform(value => value || 'note'),
    tags: z.array(z.string().trim().min(1)).default([]),
    requestId: z.uuid().optional(),
})
export type DesktopMemoryCreate = z.infer<typeof desktopMemoryCreateSchema>

export const memoryRecallQuerySchema = z.strictObject({
    query: z.string().trim().min(1),
    limit: z.number().int().min(1).max(20).default(5),
    includeDormant: z.boolean().default(false),
})
