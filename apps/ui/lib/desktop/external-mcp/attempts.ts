import { z } from 'zod'
import { externalMcpCreateInputSchema, externalMcpEnableInputSchema, externalMcpRevokeInputSchema } from '@rerun/contracts'

export const desktopExternalMcpAttemptSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('create'), input: externalMcpCreateInputSchema }),
    z.strictObject({ kind: z.literal('revoke'), input: externalMcpRevokeInputSchema }),
    z.strictObject({ kind: z.literal('enable'), input: externalMcpEnableInputSchema }),
    z.strictObject({ kind: z.literal('disable'), input: externalMcpEnableInputSchema }),
])
export type DesktopExternalMcpAttempt = z.infer<typeof desktopExternalMcpAttemptSchema>
export const desktopExternalMcpAttemptListSchema = z.array(desktopExternalMcpAttemptSchema).max(64)
