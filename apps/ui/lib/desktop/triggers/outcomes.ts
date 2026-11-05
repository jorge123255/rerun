import type { DesktopTriggerHistoryItem } from '@rerun/contracts'

export type DesktopTriggerOutcomeStatus = 'done' | 'error' | 'needs-input' | 'running'

/** Faithful to original TaskOutcome, plus needs-input/running when durable events actually say so. */
export type DesktopTriggerOutcome = {
    runId: string | null
    sessionId: string | null
    localSessionId: string | null
    status: DesktopTriggerOutcomeStatus
    finishedAt: string | null
    capturedPayload: boolean
    liveOnly: boolean
}

export const triggerOutcomeKey = (slug: string) => `trigger:${slug}`

/**
 * Latest ended (or needs-input) outcome per trigger slug from durable history only.
 * Skips cancelled/uncertain/refused as "ended success/failure". Never invents a result.
 */
export function latestTriggerOutcomes(items: DesktopTriggerHistoryItem[]): Record<string, DesktopTriggerOutcome> {
    const outcomes: Record<string, DesktopTriggerOutcome> = {}
    for (const item of items) {
        if (!item.slug) continue
        let status: DesktopTriggerOutcomeStatus | null = null
        if (item.status === 'finished') status = 'done'
        else if (item.status === 'error') status = 'error'
        else if (item.status === 'needs-input') status = 'needs-input'
        else if (item.status === 'running' || item.status === 'accepted') status = 'running'
        else continue

        const finishedAt = item.finishedAt ?? (status === 'running' || status === 'needs-input' ? null : item.receivedAt)
        const key = triggerOutcomeKey(item.slug)
        const existing = outcomes[key]
        // Prefer a real finished/error over a live running marker; otherwise keep newest receivedAt.
        if (existing) {
            const existingRank = rank(existing.status)
            const nextRank = rank(status)
            if (nextRank < existingRank) continue
            if (nextRank === existingRank) {
                const existingAt = existing.finishedAt ?? ''
                const nextAt = finishedAt ?? item.receivedAt
                if (existingAt >= nextAt) continue
            }
        }
        outcomes[key] = {
            runId: item.runId,
            sessionId: null,
            localSessionId: item.localSessionId,
            status,
            finishedAt,
            capturedPayload: item.capturedPayload,
            liveOnly: item.liveOnly,
        }
    }
    return outcomes
}

function rank(status: DesktopTriggerOutcomeStatus): number {
    if (status === 'done' || status === 'error') return 2
    if (status === 'needs-input') return 1
    return 0
}
