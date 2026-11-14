import type { PlanLimitWindow, PlanLimits } from '@rerun/contracts'

// Kept in memory on purpose: a reading is only as good as its age, and the next run or the next
// read refills it. Nothing here is worth a file a restored data-dir would have to carry.
const readings = new Map<string, PlanLimits>()

export function recordPlanLimits(connectionId: string, windows: PlanLimitWindow[]): void {
    if (!windows.length) return
    readings.set(connectionId, { windows, capturedAt: new Date().toISOString() })
}

export function readPlanLimits(connectionId: string): PlanLimits | null {
    return readings.get(connectionId) ?? null
}

export function forgetPlanLimits(connectionId: string): void {
    readings.delete(connectionId)
}

type ClaudeWindow = { utilization?: number | null; resets_at?: string | null } | null

// The part of Claude Code's `/usage` answer read here. Every field is optional because the SDK
// ships it as experimental: a shape that moved must read as "no reading", never throw.
export type ClaudePlanUsage = {
    rate_limits?: {
        five_hour?: ClaudeWindow
        seven_day?: ClaudeWindow
        seven_day_opus?: ClaudeWindow
        seven_day_sonnet?: ClaudeWindow
        model_scoped?: ({ display_name?: string } & NonNullable<ClaudeWindow>)[]
    } | null
}

function claudeWindow(kind: PlanLimitWindow['kind'], label: string | null, window: ClaudeWindow | undefined): PlanLimitWindow[] {
    if (typeof window?.utilization !== 'number') return []
    return [{ kind, label, usedPercent: window.utilization, resetsAt: window.resets_at ?? null }]
}

export function planLimitWindowsFromClaude(usage: ClaudePlanUsage | null | undefined): PlanLimitWindow[] {
    const limits = usage?.rate_limits
    if (!limits) return []
    // `model_scoped` is the newer list and names the same buckets as the two fixed fields, so the
    // fixed fields only speak when it is absent.
    const scoped = (limits.model_scoped ?? []).flatMap(w => claudeWindow('model', w.display_name ?? null, w))
    const models = scoped.length ? scoped : [...claudeWindow('model', 'Opus', limits.seven_day_opus), ...claudeWindow('model', 'Sonnet', limits.seven_day_sonnet)]
    return [...claudeWindow('session', null, limits.five_hour), ...claudeWindow('weekly', null, limits.seven_day), ...models]
}

type CodexWindow = { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null } | null

// The part of the app-server's `account/rateLimits/read` answer read here.
export type CodexRateLimits = { rateLimits?: { primary?: CodexWindow; secondary?: CodexWindow } | null }

const DAY_MINUTES = 24 * 60

// Codex does not say which window is which, and a plan with a single weekly cap reports it as
// `primary`. The duration is the only reliable tell; the slot is the fallback when it is missing.
function codexWindow(window: CodexWindow | undefined, fallback: PlanLimitWindow['kind']): PlanLimitWindow[] {
    if (typeof window?.usedPercent !== 'number') return []
    const kind = typeof window.windowDurationMins === 'number' ? (window.windowDurationMins <= DAY_MINUTES ? 'session' : 'weekly') : fallback
    const resetsAt = typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : null
    return [{ kind, label: null, usedPercent: window.usedPercent, resetsAt }]
}

/**
 * The windows a live `rate_limit_event` of the Claude runner carries. It sends both windows under
 * `unifiedWindows`; an older runner sends only the one named by `rateLimitType`, at the top level.
 * `utilization` is a fraction of 1 here, where the usage reading sends a percent.
 */
export function planLimitWindowsFromClaudeEvent(info: unknown): PlanLimitWindow[] {
    if (!info || typeof info !== 'object') return []
    const event = info as { unifiedWindows?: unknown; rateLimitType?: unknown }
    const windows = (event.unifiedWindows && typeof event.unifiedWindows === 'object' ? event.unifiedWindows
        : typeof event.rateLimitType === 'string' ? { [event.rateLimitType]: info } : {}) as Record<string, { utilization?: unknown; resetsAt?: unknown } | null | undefined>
    const read = (kind: PlanLimitWindow['kind'], window: { utilization?: unknown; resetsAt?: unknown } | null | undefined): PlanLimitWindow[] => {
        if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization) || window.utilization < 0) return []
        const reset = typeof window.resetsAt === 'number' && window.resetsAt > 0 ? (window.resetsAt > 100_000_000_000 ? window.resetsAt : window.resetsAt * 1000) : NaN
        return [{ kind, label: null, usedPercent: window.utilization * 100, resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null }]
    }
    return [...read('session', windows.five_hour), ...read('weekly', windows.seven_day)]
}

/** Records the windows of a partial reading over the last one, keeping the windows it does not mention. */
export function mergePlanLimits(connectionId: string, windows: PlanLimitWindow[]): void {
    if (!windows.length) return
    const same = (a: PlanLimitWindow, b: PlanLimitWindow) => a.kind === b.kind && a.label === b.label
    const kept = (readPlanLimits(connectionId)?.windows ?? []).filter(old => !windows.some(window => same(window, old)))
    const order = { session: 0, weekly: 1, model: 2 }
    recordPlanLimits(connectionId, [...windows, ...kept].sort((a, b) => order[a.kind] - order[b.kind]))
}

// Grok's answer to its own `_x.ai/billing` call. Its service writes proto3 JSON, which leaves a zero
// out: a period with nothing used yet has no `creditUsagePercent`.
export type GrokBilling = { config?: { creditUsagePercent?: unknown; currentPeriod?: { type?: unknown; start?: unknown; end?: unknown } | null } | null }

export function planLimitWindowsFromGrok(response: GrokBilling | null | undefined): PlanLimitWindow[] {
    const config = response?.config, period = config?.currentPeriod
    if (!config || !period) return []
    const used = config.creditUsagePercent === undefined ? 0 : config.creditUsagePercent
    if (typeof used !== 'number' || !Number.isFinite(used)) return []
    const start = typeof period.start === 'string' ? Date.parse(period.start) : NaN, end = typeof period.end === 'string' ? Date.parse(period.end) : NaN
    const days = (end - start) / (DAY_MINUTES * 60_000)
    const weekly = typeof period.type === 'string' && /week/i.test(period.type) || Math.abs(days - 7) < 0.5
    return [{
        kind: weekly ? 'weekly' : 'model', label: weekly ? null : Number.isFinite(days) ? `${Math.round(days)}-day credits` : 'Credits',
        usedPercent: Math.max(0, Math.min(100, used)), resetsAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
    }]
}

// Kimi Code's answer to `GET /coding/v1/usages`: one entry per quota, each a ratio of 1.
type KimiQuota = { used_ratio?: unknown; reset_time?: unknown } | null
export type KimiUsage = { usages?: { limit_5h?: KimiQuota; limit_7d?: KimiQuota; limit_month_total?: KimiQuota } | null }

function kimiWindow(kind: PlanLimitWindow['kind'], label: string | null, quota: KimiQuota | undefined): PlanLimitWindow[] {
    const ratio = typeof quota?.used_ratio === 'string' && quota.used_ratio.trim() ? Number(quota.used_ratio) : quota?.used_ratio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return []
    const reset = typeof quota?.reset_time === 'string' ? Date.parse(quota.reset_time) : NaN
    return [{ kind, label, usedPercent: Math.max(0, Math.min(100, ratio * 100)), resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null }]
}

export function planLimitWindowsFromKimi(response: KimiUsage | null | undefined): PlanLimitWindow[] {
    const usages = response?.usages
    if (!usages || typeof usages !== 'object') return []
    return [...kimiWindow('session', null, usages.limit_5h), ...kimiWindow('weekly', null, usages.limit_7d), ...kimiWindow('model', 'Monthly', usages.limit_month_total)]
}

export function planLimitWindowsFromCodex(response: CodexRateLimits | null | undefined): PlanLimitWindow[] {
    const limits = response?.rateLimits
    if (!limits) return []
    return [...codexWindow(limits.primary, 'session'), ...codexWindow(limits.secondary, 'weekly')]
}
