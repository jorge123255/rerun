import { useMemo, useState } from 'react'

type TimedMessage = { id: string; metadata?: unknown }

const createdAtOf = (message: TimedMessage) => {
    const createdAt = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
    return typeof createdAt === 'string' ? createdAt : undefined
}

/**
 * When each message was written, as on the web. The history carries the engine's time; a message sent
 * or streamed while the conversation is open has none until it is read back, so it is dated the moment
 * it first showed up.
 */
export function useMessageTimes(messages: readonly TimedMessage[]): string[] {
    const [firstSeen] = useState(() => new Map<string, string>())
    return useMemo(
        () =>
            messages.map(message => {
                const createdAt = createdAtOf(message)
                if (createdAt) return createdAt
                const seen = firstSeen.get(message.id) ?? new Date().toISOString()
                firstSeen.set(message.id, seen)
                return seen
            }),
        [messages, firstSeen]
    )
}
