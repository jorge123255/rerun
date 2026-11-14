import { describe, expect, it } from 'vitest'
import { forgetPlanLimits, planLimitWindowsFromClaude, planLimitWindowsFromCodex, planLimitWindowsFromGrok, planLimitWindowsFromKimi, readPlanLimits, recordPlanLimits } from './plan-limits.js'

describe('planLimitWindowsFromClaude', () => {
    it('reads the session, weekly and per-model windows', () => {
        const windows = planLimitWindowsFromClaude({
            rate_limits: {
                five_hour: { utilization: 42, resets_at: '2026-10-05T15:00:00Z' },
                seven_day: { utilization: 71, resets_at: '2026-10-09T08:00:00Z' },
                seven_day_opus: { utilization: 12, resets_at: null },
                seven_day_sonnet: null,
            },
        })
        expect(windows).toEqual([
            { kind: 'session', label: null, usedPercent: 42, resetsAt: '2026-10-05T15:00:00Z' },
            { kind: 'weekly', label: null, usedPercent: 71, resetsAt: '2026-10-09T08:00:00Z' },
            { kind: 'model', label: 'Opus', usedPercent: 12, resetsAt: null },
        ])
    })

    it('prefers model_scoped over the fixed per-model fields naming the same buckets', () => {
        const windows = planLimitWindowsFromClaude({
            rate_limits: {
                seven_day_opus: { utilization: 12, resets_at: null },
                model_scoped: [{ display_name: 'Fable', utilization: 30, resets_at: '2026-10-09T08:00:00Z' }],
            },
        })
        expect(windows).toEqual([{ kind: 'model', label: 'Fable', usedPercent: 30, resetsAt: '2026-10-09T08:00:00Z' }])
    })

    it('reads nothing off a session where plan limits do not apply', () => {
        expect(planLimitWindowsFromClaude({ rate_limits: null })).toEqual([])
        expect(planLimitWindowsFromClaude(undefined)).toEqual([])
        expect(planLimitWindowsFromClaude({ rate_limits: { five_hour: { utilization: null, resets_at: null } } })).toEqual([])
    })
})

describe('planLimitWindowsFromCodex', () => {
    it('names a window after its duration, whichever slot reports it', () => {
        const weeklyOnly = planLimitWindowsFromCodex({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1791580463 }, secondary: null } })
        expect(weeklyOnly).toEqual([{ kind: 'weekly', label: null, usedPercent: 20, resetsAt: '2026-10-09T21:14:23.000Z' }])

        const both = planLimitWindowsFromCodex({
            rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: null } },
        })
        expect(both.map(w => w.kind)).toEqual(['session', 'weekly'])
    })

    it('falls back on the slot when the duration is missing', () => {
        const windows = planLimitWindowsFromCodex({ rateLimits: { primary: { usedPercent: 5 }, secondary: { usedPercent: 60 } } })
        expect(windows.map(w => w.kind)).toEqual(['session', 'weekly'])
    })

    it('reads nothing off a failed read', () => {
        expect(planLimitWindowsFromCodex(null)).toEqual([])
        expect(planLimitWindowsFromCodex({ rateLimits: null })).toEqual([])
    })
})

describe('planLimitWindowsFromGrok', () => {
    const period = { type: 'BILLING_PERIOD_TYPE_WEEKLY', start: '2026-11-09T19:49:24.473066+00:00', end: '2026-11-16T19:49:24.473066+00:00' }

    it('reads the weekly credit use and its reset', () => {
        expect(planLimitWindowsFromGrok({ config: { creditUsagePercent: 23, currentPeriod: period } }))
            .toEqual([{ kind: 'weekly', label: null, usedPercent: 23, resetsAt: '2026-11-16T19:49:24.473Z' }])
    })

    it('reads a period with nothing used yet, which Grok writes without a percent', () => {
        expect(planLimitWindowsFromGrok({ config: { currentPeriod: period } })[0]).toMatchObject({ kind: 'weekly', usedPercent: 0 })
    })

    it('names a period that is not a week by its length', () => {
        const monthly = { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' }
        expect(planLimitWindowsFromGrok({ config: { creditUsagePercent: 150, currentPeriod: monthly } }))
            .toEqual([{ kind: 'model', label: '30-day credits', usedPercent: 100, resetsAt: '2026-12-01T00:00:00.000Z' }])
    })

    it('has no reading without a current period or with a percent that is not a number', () => {
        expect(planLimitWindowsFromGrok(null)).toEqual([])
        expect(planLimitWindowsFromGrok({ config: { creditUsagePercent: 10 } })).toEqual([])
        expect(planLimitWindowsFromGrok({ config: { creditUsagePercent: '10', currentPeriod: period } })).toEqual([])
    })
})

describe('planLimitWindowsFromKimi', () => {
    it('reads the five-hour, weekly and monthly quotas, each a ratio of 1', () => {
        expect(planLimitWindowsFromKimi({ usages: {
            limit_5h: { used_ratio: 0.25, reset_time: '2026-11-14T18:00:00Z' }, limit_7d: { used_ratio: '0.5' }, limit_month_total: { used_ratio: 1.4, reset_time: '2026-12-01T00:00:00Z' },
        } })).toEqual([
            { kind: 'session', label: null, usedPercent: 25, resetsAt: '2026-11-14T18:00:00.000Z' },
            { kind: 'weekly', label: null, usedPercent: 50, resetsAt: null },
            { kind: 'model', label: 'Monthly', usedPercent: 100, resetsAt: '2026-12-01T00:00:00.000Z' },
        ])
    })

    it('has no reading for an answer without quotas', () => {
        expect(planLimitWindowsFromKimi(null)).toEqual([])
        expect(planLimitWindowsFromKimi({ usages: { limit_5h: { used_ratio: 'soon' }, limit_7d: null } })).toEqual([])
    })
})

describe('plan limits store', () => {
    it('keeps the last reading when a later one comes back empty', () => {
        recordPlanLimits('c1', [{ kind: 'session', label: null, usedPercent: 10, resetsAt: null }])
        recordPlanLimits('c1', [])
        expect(readPlanLimits('c1')?.windows).toHaveLength(1)
        forgetPlanLimits('c1')
        expect(readPlanLimits('c1')).toBeNull()
    })
})
