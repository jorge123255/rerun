import { Cron } from 'croner'
import { describe, expect, it, vi } from 'vitest'
import { isDue, nextRunAt } from './cron.js'
import { computeNextRun, isValidTimezone } from './next-run.js'
import type { Schedule } from './loader.js'

const now = new Date('2026-06-02T12:00:00.000Z')
function routine(patch: Partial<Schedule> = {}): Schedule {
    return { slug: 'daily', name: 'Daily', description: '', enabled: true,
        cron: '0 8 * * *', runAt: null, timezone: 'UTC', lastRunAt: null,
        connectionId: null, provider: null, model: null, body: 'Keep this body',
        createdAt: '2026-06-01T00:00:00.000Z', ...patch }
}

describe('contained schedule computation', () => {
    it('keeps evaluating later rows after malformed cron, timezone or baseline', () => {
        const rows = [routine({ cron: 'bad cron' }), routine({ timezone: 'Not/AZone' }),
            routine({ createdAt: 'broken date' }), routine()]
        const before = JSON.stringify(rows)
        expect(rows.filter(row => isDue(row, now))).toEqual([rows[3]])
        expect(rows.map(row => nextRunAt(row, now))).toEqual([
            null, null, '2026-06-03T08:00:00.000Z', '2026-06-03T08:00:00.000Z',
        ])
        expect(JSON.stringify(rows)).toBe(before)
    })

    it('contains a deferred decoder failure and computes the following routine', () => {
        const spy = vi.spyOn(Cron.prototype, 'nextRun').mockImplementationOnce(() => { throw new RangeError('compute failed') })
        try {
            expect(isDue(routine(), now)).toBe(false)
            expect(isDue(routine(), now)).toBe(true)
        } finally { spy.mockRestore() }
    })

    it('uses the selected zone across spring and autumn offset changes', () => {
        const timing = { cron: '0 9 * * *', timezone: 'America/New_York' }
        expect(computeNextRun(timing, new Date('2026-03-07T15:00:00Z'))).toEqual({ ok: true, next: new Date('2026-03-08T13:00:00Z') })
        expect(computeNextRun(timing, new Date('2026-10-31T15:00:00Z'))).toEqual({ ok: true, next: new Date('2026-11-01T14:00:00Z') })
    })

    it('validates zones by computation and rejects invalid evaluation dates', () => {
        expect(isValidTimezone('UTC')).toBe(true)
        expect(isValidTimezone('Europe/Paris')).toBe(true)
        expect(isValidTimezone('Not/AZone')).toBe(false)
        expect(isValidTimezone('')).toBe(false)
        expect(computeNextRun({ cron: '* * * * *', timezone: 'UTC' }, new Date('bad'))).toEqual({ ok: false })
    })

    it('preserves disabled, spent one-shot and exhausted-cron semantics', () => {
        expect(isDue(routine({ enabled: false, cron: 'bad' }), now)).toBe(false)
        const spent = routine({ cron: null, runAt: '2026-06-01T00:00:00Z', lastRunAt: '2026-06-01T00:00:01Z' })
        expect(isDue(spent, now)).toBe(false)
        expect(nextRunAt(spent, now)).toBeNull()
        const spy = vi.spyOn(Cron.prototype, 'nextRun').mockReturnValueOnce(null)
        try { expect(computeNextRun({ cron: '0 8 * * *', timezone: 'UTC' }, now)).toEqual({ ok: true, next: null }) }
        finally { spy.mockRestore() }
    })
})
