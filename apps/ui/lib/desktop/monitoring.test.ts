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
