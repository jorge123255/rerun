import { z } from 'zod'

import { agentDetailSchema } from './agent.js'

export const workspaceSummarySchema = z.object({
    id: z.number(),
    name: z.string().nullable(),
    iconUrl: z.string().nullable(),
    plan: z.string(),
    // A subscription in force, a trial included: without one the workspace has no machine to run coworkers.
    subscribed: z.boolean(),
})
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>

export const boxSchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    createdAt: z.string().nullable(),
    // Runs on an instance Rerun provisioned, as opposed to an engine the workspace hosts itself.
    managed: z.boolean(),
})
export type Box = z.infer<typeof boxSchema>

export const agentStatusSchema = z.enum(['idle', 'working', 'error', 'waiting_human', 'offline'])
export type AgentStatus = z.infer<typeof agentStatusSchema>

export const boardAgentSchema = z.object({
    id: z.string(),
    name: z.string(),
    handle: z.string().nullable(),
    description: z.string().nullable(),
    templateId: z.string().nullable(),
    status: agentStatusSchema,
    workspaceId: z.number(),
    spaceId: z.string(),
    disabledAt: z.string().nullable(),
    disabledReason: z.string().nullable(),
})
export type BoardAgent = z.infer<typeof boardAgentSchema>

// What each engine answered for its agents on the last poll. `unconfigured` is an agent whose Box
// has no engine behind it yet.
export const agentHealthSchema = z.record(z.string(), z.union([agentStatusSchema, z.literal('unconfigured')]))
export type AgentHealth = z.infer<typeof agentHealthSchema>

export const agentViewSchema = z.object({
    agent: boardAgentSchema,
    // Null for a switched-off agent: nothing on its Box answers for it.
    detail: agentDetailSchema.nullable(),
    // Always false since template content is no longer sealed (upstream #252); kept because shipped
    // clients parse it as a required field.
    locked: z.boolean(),
})
export type AgentView = z.infer<typeof agentViewSchema>
