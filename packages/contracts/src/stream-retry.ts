import { z } from 'zod'

// The live part the engine writes while it sends a step again after a dropped model stream. It is
// re-emitted under one id, so the conversation holds one of them per run and its last status wins.
// It carries no error text: what went wrong only reaches the person if the retries run out.
export const STREAM_RETRY_PART = 'data-stream-retry'

export const streamRetryDataSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('reconnecting'), provider: z.string().min(1).max(80), attempt: z.number().int().min(1).max(10), of: z.number().int().min(1).max(10) }),
    z.object({ status: z.literal('resumed'), provider: z.string().min(1).max(80) }),
    z.object({ status: z.literal('failed'), provider: z.string().min(1).max(80) }),
])
export type StreamRetryData = z.infer<typeof streamRetryDataSchema>

/** The provider being reconnected to right now, or null. Only the last retry part of a reply counts. */
export function reconnectingProvider(parts: readonly unknown[]): string | null {
    const last = parts.findLast(part => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === STREAM_RETRY_PART)
    const parsed = streamRetryDataSchema.safeParse((last as { data?: unknown } | undefined)?.data)
    return parsed.success && parsed.data.status === 'reconnecting' ? parsed.data.provider : null
}
