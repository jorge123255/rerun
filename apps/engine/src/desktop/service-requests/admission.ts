import { findDesktopServiceRequest, type DesktopServiceRequestGuard, type DesktopServiceRequestRow } from '@rerun/contracts'

export const desktopServicePendingMessage = 'Finish or dismiss the coworker’s app setup before sending another message.'

export type DesktopServiceTurnDecision =
    | { kind: 'not-service' }
    | { kind: 'admit' }
    | { kind: 'reject'; status: 400 | 409; code: 'service_guard' | 'service_mismatch'; error: string }
    | { kind: 'block'; status: 409; code: 'service_pending'; error: string }

// Call this only after an already reserved run has been resumed and a replay-only miss has returned.
// A sealed follow-up replays by its saved run id; this check admits the first send of that one run.
export function decideDesktopServiceRequestTurn(input: {
    rows: readonly DesktopServiceRequestRow[]
    queued?: { service?: DesktopServiceRequestGuard; question?: unknown; approval?: unknown }
}): DesktopServiceTurnDecision {
    const pending = findDesktopServiceRequest(input.rows)
    const queued = input.queued
    if (queued?.service) {
        if (queued.question || queued.approval) return { kind: 'reject', status: 400, code: 'service_guard', error: 'An app setup follow-up cannot also answer a question or an approval.' }
        const expected = queued.service
        if (!pending || pending.sourceMessageId !== expected.sourceMessageId || pending.toolCallId !== expected.toolCallId || pending.fingerprint !== expected.fingerprint) {
            return { kind: 'reject', status: 409, code: 'service_mismatch', error: 'This app setup is no longer waiting for a result. Reload the conversation.' }
        }
        return { kind: 'admit' }
    }
    if (pending && !queued?.question && !queued?.approval) return { kind: 'block', status: 409, code: 'service_pending', error: desktopServicePendingMessage }
    return { kind: 'not-service' }
}
