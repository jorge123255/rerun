import { describe, expect, it } from 'vitest'

import { humanCron, nextRunAt, routineFrequency } from '@/lib/schedules/cron'

const NOW = new Date('2026-09-30T10:00:00.000Z')
const RECURRING = { enabled: true, cron: '0 9 * * *', runAt: null, timezone: 'Europe/Paris', lastRunAt: null }

describe('nextRunAt', () => {
    it('reads the cron in its timezone', () => {
        expect(nextRunAt(RECURRING, NOW)).toBe('2026-10-01T07:00:00.000Z')
    })

    it('has no next run while paused', () => {
        expect(nextRunAt({ ...RECURRING, enabled: false }, NOW)).toBeNull()
    })

    it('returns the instant of a one-off that has not fired', () => {
        expect(nextRunAt({ ...RECURRING, cron: null, runAt: '2026-10-02T08:00:00.000Z' }, NOW)).toBe('2026-10-02T08:00:00.000Z')
    })

    it('has no next run once a one-off has fired', () => {
        expect(nextRunAt({ ...RECURRING, cron: null, runAt: '2026-09-29T08:00:00.000Z', lastRunAt: '2026-09-29T08:00:05.000Z' }, NOW)).toBeNull()
    })

    it('swallows an invalid expression', () => {
        expect(nextRunAt({ ...RECURRING, cron: 'not a cron' }, NOW)).toBeNull()
    })
})

describe('routineFrequency', () => {
    const cron = (expression: string) => routineFrequency({ cron: expression, runAt: null })

    it('reads the daily, weekday, weekly and monthly shapes', () => {
        expect(cron('15 8 * * *')).toBe('Every day at 8:15 AM')
        expect(cron('15 12,16 * * *')).toBe('Every day at 12:15 PM, 4:15 PM')
        expect(cron('30 10 * * 1-5')).toBe('Weekdays at 10:30 AM')
        expect(cron('0 9 * * 1')).toBe('Every Monday at 9:00 AM')
        expect(cron('0 6 1 * *')).toBe('Monthly on day 1 at 6:00 AM')
        expect(cron('*/15 * * * *')).toBe('Every 15 minutes')
    })

    it('falls back to cronstrue for the other shapes', () => {
        expect(cron('0 9-17 * * *')).toBe('Every hour, between 09:00 AM and 05:00 PM')
        expect(cron('not a cron')).toBe('not a cron')
    })

    it('reads a one-off as its date', () => {
        expect(routineFrequency({ cron: null, runAt: '2026-10-24T11:00:00.000Z' })).toMatch(/^Once, Oct 24, /)
    })
})


describe('localized cron descriptions', () => {
    it('loads French and Brazilian Portuguese for cron rules outside the shortcut patterns', () => {
        expect(humanCron('0 9-17 * * *', 'fr')).toBe('Toutes les heures, de 09:00 à 17:00')
        expect(humanCron('0 9-17 * * *', 'pt-BR')).toBe('A cada hora, entre 09:00 e 17:00')
        expect(humanCron('not a cron', 'fr')).toBeNull()
    })
})
