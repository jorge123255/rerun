import { SUBSCRIPTION_PROFILE_UNKNOWN } from './contract'

export type SubscriptionProfileAttempt = { status: 'saved' | 'refused' | 'uncertain'; message: string }

/** Drops a stale reply and does not send an uncertain stop or selection again. */
export function createSubscriptionProfileSession(port: { attempt: (requestId: string) => Promise<SubscriptionProfileAttempt> }) {
    let generation = 0
    const sent = new Set<string>()
    return {
        async once(requestId: string): Promise<SubscriptionProfileAttempt> {
            if (sent.has(requestId)) return { status: 'uncertain', message: SUBSCRIPTION_PROFILE_UNKNOWN }
            sent.add(requestId)
            const version = ++generation
            const result = await port.attempt(requestId)
            if (version !== generation) return { status: 'uncertain', message: SUBSCRIPTION_PROFILE_UNKNOWN }
            return result
        },
        invalidate() { generation += 1 },
    }
}
