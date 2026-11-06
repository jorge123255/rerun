import { z } from 'zod'

export const DESKTOP_CLAUDE_CONNECTION_ID = 'mac-claude' as const
export const DESKTOP_CLAUDE_PLAN_AUTH_LIFETIME_MS = 15 * 60_000
const revision = z.string().regex(/^(?:0|[1-9][0-9]{0,17})$/)
const attemptId = z.string().uuid()
export const desktopClaudePlanSnapshotSchema = z.object({
    connectionId: z.literal(DESKTOP_CLAUDE_CONNECTION_ID),
    attemptId: attemptId.nullable(),
    revision,
    phase: z.enum(['idle', 'waiting', 'checking', 'connected', 'cancelled', 'expired', 'error', 'disconnected']),
    authorizeUrl: z.string().url().refine(value => { const url = new URL(value); return url.origin === 'https://claude.ai' && url.pathname === '/oauth/authorize' }).optional(),
    error: z.string().max(300).optional(),
    credentialRevision: revision.optional(),
}).strict()
export type DesktopClaudePlanSnapshot = z.infer<typeof desktopClaudePlanSnapshotSchema>
const mutation = { requestId: z.string().uuid(), attemptId: attemptId.nullable(), expectedRevision: revision }
export const desktopClaudePlanActionSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('start'), ...mutation }).strict(),
    z.object({ operation: z.literal('complete'), ...mutation, code: z.string().trim().min(1).max(8192) }).strict(),
    z.object({ operation: z.literal('token'), ...mutation, token: z.string().trim().min(1).max(8192) }).strict(),
    z.object({ operation: z.literal('cancel'), ...mutation }).strict(),
    z.object({ operation: z.literal('disconnect'), ...mutation }).strict(),
])
export type DesktopClaudePlanAction = z.infer<typeof desktopClaudePlanActionSchema>
export type DesktopClaudePlanCredential = { accessToken: string; refreshToken?: string; expiresAt?: number }
