import type { ConnectionSummary, PlanLimitWindow } from '@rerun/contracts'
import { livePlanWindows } from '@/lib/engine/ai-sources'

export const DESKTOP_PLAN_USAGE_STALE_AFTER_MS = 5 * 60 * 1000
export const DESKTOP_PLAN_USAGE_WINDOW_LIMIT = 3

export type DesktopPlanUsage = {
    status: 'unknown' | 'ready' | 'stale'
    reason: 'unsupported-provider' | 'missing-reading' | 'empty-reading' | 'fresh' | 'stale-reading' | 'invalid-captured-at'
    capturedAt: string | null
    windows: PlanLimitWindow[]
}

function boundedPlanWindows(windows: PlanLimitWindow[]): PlanLimitWindow[] {
    const plan = windows.filter(window => window.kind !== 'model')
    const models = windows.filter(window => window.kind === 'model').sort((a, b) => b.usedPercent - a.usedPercent)
    return [...plan, ...models].slice(0, DESKTOP_PLAN_USAGE_WINDOW_LIMIT)
}

export function desktopPlanUsage(connection: Pick<ConnectionSummary, 'provider' | 'planLimits'>, now = Date.now()): DesktopPlanUsage {
    if (connection.provider !== 'codex') {
        return { status: 'unknown', reason: 'unsupported-provider', capturedAt: null, windows: [] }
    }
    if (!connection.planLimits) {
        return { status: 'unknown', reason: 'missing-reading', capturedAt: null, windows: [] }
    }
    const windows = boundedPlanWindows(livePlanWindows(connection, now))
    if (windows.length === 0) {
        return { status: 'unknown', reason: 'empty-reading', capturedAt: null, windows: [] }
    }
    const capturedAt = connection.planLimits.capturedAt
    const capturedAtMs = Date.parse(capturedAt)
    if (!Number.isFinite(capturedAtMs)) {
        return { status: 'stale', reason: 'invalid-captured-at', capturedAt: null, windows }
    }
    if (now - capturedAtMs > DESKTOP_PLAN_USAGE_STALE_AFTER_MS) {
        return { status: 'stale', reason: 'stale-reading', capturedAt, windows }
    }
    return { status: 'ready', reason: 'fresh', capturedAt, windows }
}
