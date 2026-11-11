import { chartBucketLabel, statsValueFormatter } from '../../../../packages/ui/src/monitoring/chart-format'
import { expect, test } from 'vitest'
import { dailyTokenUsage } from './monitoring'

const point = (bucket: string, value: number, count: number) => ({ bucket, group: null, value, count })

test('merges hourly points into calendar days and keeps measured zeroes', () => {
    expect(dailyTokenUsage([
        point('2026-11-02T23:00', 10, 2),
        point('2026-11-02T22:00', 5, 1),
        point('2026-11-03T01:00', 0, 3),
        point('2026-11-03T02:00', 7, 1),
    ])).toEqual([
        { day: '2026-11-02', totalTokens: 15, runCount: 3 },
        { day: '2026-11-03', totalTokens: 7, runCount: 4 },
    ])
    expect(dailyTokenUsage([point('2026-11-03', 0, 2)])).toEqual([{ day: '2026-11-03', totalTokens: 0, runCount: 2 }])
    expect(dailyTokenUsage([])).toEqual([])
})

test('keeps UTC hour buckets intact and formats dates and recorded units in the selected locale', () => {
    const locale = 'fr'
    const date = new Date('2026-11-03T12:00:00Z')
    const hour = date.toLocaleTimeString(locale, { hour: 'numeric' })
    expect(chartBucketLabel('2026-11-03T12:00', locale)).toBe(hour)
    expect(chartBucketLabel('2026-11-03T12', locale)).toBe(hour)
    expect(chartBucketLabel('2026-11-03', locale)).toBe(new Date('2026-11-03T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric' }))
    expect(chartBucketLabel('invalid', locale)).toBe('invalid')
    expect(statsValueFormatter('cost', locale, true)(1)).toBe(new Intl.NumberFormat(locale, {
        style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
    }).format(0.000001))
    expect(statsValueFormatter('errorRate', locale)(0.125)).toBe(new Intl.NumberFormat(locale, {
        style: 'percent', minimumFractionDigits: 1,
    }).format(0.125))
    expect(statsValueFormatter('avgDurationMs', locale)(1250)).toBe(new Intl.NumberFormat(locale, {
        style: 'unit', unit: 'second', unitDisplay: 'narrow', minimumFractionDigits: 1, maximumFractionDigits: 1,
    }).format(1.25))
})
