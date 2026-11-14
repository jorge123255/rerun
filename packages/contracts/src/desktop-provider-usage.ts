import { z } from 'zod'

const window = z.object({ replies: z.number().int().nonnegative(), tokens: z.number().int().nonnegative() })
/**
 * What this Mac itself ran on each provider: finished replies and the tokens the provider reported
 * for them, over the last day and the last seven. A provider that reports no tokens counts zero.
 */
export const desktopProviderUsageSchema = z.object({
    since: z.object({ day: z.iso.datetime(), week: z.iso.datetime() }),
    providers: z.record(z.string(), z.object({ day: window, week: window })),
})
export type DesktopProviderUsage = z.infer<typeof desktopProviderUsageSchema>
