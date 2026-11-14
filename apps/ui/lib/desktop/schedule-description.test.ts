import { describe, expect, it } from 'vitest'
import { DESKTOP_SCHEDULE_UNAVAILABLE, unavailableDesktopScheduleParser, validateDesktopSchedulePreview } from './schedule-description'

describe('unavailableDesktopScheduleParser', () => {
    it('reports the truthful unavailable state without parsing or substituting', async () => {
        await expect(unavailableDesktopScheduleParser({
            description: 'weekdays at 8', nowIso: '2026-11-09T12:00:00Z', timezone: 'America/Chicago', signal: new AbortController().signal,
        })).resolves.toEqual({ status: 'unavailable', message: DESKTOP_SCHEDULE_UNAVAILABLE })
    })
})

describe('validateDesktopSchedulePreview', () => {
    it('validates recurring output and preserves the exact current timezone', () => {
        expect(validateDesktopSchedulePreview({ mode: 'cron', cron: '0 8 * * 1-5', label: 'Weekdays at 8' }, 'America/Chicago')).toEqual({
            selection: { mode: 'cron', cron: '0 8 * * 1-5', runAt: null, timezone: 'America/Chicago' }, label: 'Weekdays at 8',
        })
    })

    it('validates one-shot output with an explicit offset and uses its label fallback', () => {
        expect(validateDesktopSchedulePreview({ mode: 'runAt', runAt: '2026-11-10T08:00:00-06:00' }, 'America/Chicago', Date.parse('2026-11-09T18:00:00Z'))).toEqual({
            selection: { mode: 'runAt', cron: null, runAt: '2026-11-10T08:00:00-06:00', timezone: 'America/Chicago' }, label: '2026-11-10T08:00:00-06:00',
        })
    })

    it('refuses a one-shot preview when the offset resolves to a time that has passed', () => {
        expect(validateDesktopSchedulePreview({ mode: 'runAt', runAt: '2026-11-10T08:00:00-06:00' },
            'America/Chicago', Date.parse('2026-11-10T14:00:00Z'))).toBeNull()
    })

    it('shows an explicit valid returned timezone in the preview', () => {
        expect(validateDesktopSchedulePreview({ mode: 'cron', cron: '0 8 * * *', timezone: 'Europe/Paris' }, 'America/Chicago')?.selection.timezone).toBe('Europe/Paris')
    })

    it.each([
        ['malformed cron', { mode: 'cron', cron: 'not a cron' }],
        ['runAt without an offset', { mode: 'runAt', runAt: '2026-11-10T08:00:00' }],
        ['both timing forms', { mode: 'cron', cron: '0 8 * * *', runAt: '2026-11-10T08:00:00Z' }],
        ['missing cron', { mode: 'cron' }],
        ['missing runAt', { mode: 'runAt' }],
        ['invalid returned timezone', { mode: 'cron', cron: '0 8 * * *', timezone: 'Not/AZone' }],
        ['unexpected fields', { mode: 'cron', cron: '0 8 * * *', extra: true }],
        ['unknown mode', { mode: 'later', runAt: '2026-11-10T08:00:00Z' }],
    ])('rejects %s', (_kind, value) => {
        expect(validateDesktopSchedulePreview(value, 'America/Chicago')).toBeNull()
    })

    it('rejects an invalid current timezone instead of substituting the system timezone', () => {
        expect(validateDesktopSchedulePreview({ mode: 'cron', cron: '0 8 * * *' }, 'Not/AZone')).toBeNull()
    })
})
