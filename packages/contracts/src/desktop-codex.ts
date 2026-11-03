import { z } from 'zod'

export const desktopCodexStatus = z.discriminatedUnion('phase', [
    z.object({ phase: z.literal('idle') }),
    z.object({ phase: z.literal('waiting'), verificationUrl: z.literal('https://auth.openai.com/codex/device'), userCode: z.string().min(1), expiresAt: z.number() }),
    z.object({ phase: z.literal('connected') }),
    z.object({ phase: z.literal('error'), message: z.string() }),
])
export type DesktopCodexStatus = z.infer<typeof desktopCodexStatus>
export const desktopCodexAction = z.enum(['start', 'cancel', 'logout'])
