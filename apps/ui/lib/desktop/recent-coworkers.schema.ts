import { z } from 'zod'

const agentId = z.string().min(1).max(200)
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const desktopRecentCoworkersSchema = z.object({
    revision,
    recentAgentIds: z.array(agentId).max(5).refine(ids => new Set(ids).size === ids.length),
})
export type DesktopRecentCoworkers = z.infer<typeof desktopRecentCoworkersSchema>

export const desktopRecentCoworkerVisitSchema = z.object({
    agentId,
    baseRevision: revision,
    requestId: z.string().uuid(),
}).strict()
export type DesktopRecentCoworkerVisit = z.infer<typeof desktopRecentCoworkerVisitSchema>
