import { z } from 'zod'

export const DESKTOP_FOREMAN_LIVE_REPLY_LIMIT = 24_000

export const desktopForemanLiveReplySchema = z.strictObject({
    runId: z.string().min(1).max(128),
    text: z.string().min(1).max(DESKTOP_FOREMAN_LIVE_REPLY_LIMIT),
})
