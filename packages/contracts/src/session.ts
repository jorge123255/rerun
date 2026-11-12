import { z } from 'zod'

export const sessionSourceSchema = z.enum(['dashboard', 'builder', 'schedule', 'agent', 'delegate', 'api', 'trigger'])
export type SessionSource = z.infer<typeof sessionSourceSchema>

export const desktopAutomationResultSchema = z.strictObject({
    title: z.string().trim().min(1).max(80),
    outcome: z.enum(['done', 'nothing']),
})
export type DesktopAutomationResult = z.infer<typeof desktopAutomationResultSchema>

export const sessionSchema = z.object({
    id: z.string(),
    agentId: z.string(),
    title: z.string(),
    status: z.string(),
    source: sessionSourceSchema.default('dashboard'),
    originAgentId: z.string().nullable().default(null),
    originSessionId: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
    automationResult: desktopAutomationResultSchema.optional(),
})
export type Session = z.infer<typeof sessionSchema>

export const sessionsListSchema = z.object({ sessions: z.array(sessionSchema) })

export const messageRoleSchema = z.enum(['user', 'assistant', 'tool'])
export type MessageRole = z.infer<typeof messageRoleSchema>

const compactionId = z.string().regex(/^[a-z0-9]{21}$/)
export const desktopCompactionReceiptSchema = z.discriminatedUnion('status', [
    z.strictObject({ id: compactionId, status: z.literal('done'), messagesCompacted: z.number().int().positive(), tokensRecovered: z.number().int().nonnegative() }),
    z.strictObject({ id: compactionId, status: z.literal('error') }),
])
export type DesktopCompactionReceipt = z.infer<typeof desktopCompactionReceiptSchema>

export const messageSchema = z.object({
    desktopCompaction: desktopCompactionReceiptSchema.optional(),
    desktopRunId: z.string().uuid().nullish(),
    foremanRunId: z.string().min(1).max(128).nullish(),
    id: z.string(),
    sessionId: z.string(),
    role: messageRoleSchema,
    contentJson: z.string(),
    toolCallsJson: z.string().nullable(),
    sourcesJson: z.string().nullish(),
    // Absent on an engine older than message attribution, null when nobody typed the message.
    authorId: z.string().nullish(),
    authorName: z.string().nullish(),
    createdAt: z.string(),
})
export type Message = z.infer<typeof messageSchema>

export const messagesListSchema = z.object({ messages: z.array(messageSchema) })
