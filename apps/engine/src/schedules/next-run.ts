import { Cron } from 'croner'

export type CronTiming = { cron: string; timezone: string | null }
export type CronComputation = { ok: true; next: Date | null } | { ok: false }

/** A missing future occurrence is valid; a failed computation must stay local to this routine. */
export function computeNextRun(timing: CronTiming, from: Date): CronComputation {
    try {
        if (!Number.isFinite(from.getTime())) return { ok: false }
        const next = new Cron(timing.cron, timing.timezone ? { timezone: timing.timezone } : undefined).nextRun(from)
        if (next && !Number.isFinite(next.getTime())) return { ok: false }
        return { ok: true, next }
    } catch {
        return { ok: false }
    }
}

export function nextCronRun(timing: CronTiming, from: Date): Date | null {
    const result = computeNextRun(timing, from)
    return result.ok ? result.next : null
}

export function isValidTimezone(timezone: string): boolean {
    return timezone.length > 0 && computeNextRun({ cron: '* * * * *', timezone }, new Date('2026-01-01T00:00:00.000Z')).ok
}

export class ScheduleTimingError extends Error {
    constructor(readonly field: 'cron' | 'timezone') {
        super(field === 'timezone' ? 'Invalid timezone' : 'Invalid cron expression')
        this.name = 'ScheduleTimingError'
    }
}

export function assertComputableTiming(timing: { cron: string | null; timezone: string | null }, from: Date): void {
    if (timing.timezone && !isValidTimezone(timing.timezone)) throw new ScheduleTimingError('timezone')
    if (timing.cron && !computeNextRun({ cron: timing.cron, timezone: timing.timezone }, from).ok) throw new ScheduleTimingError('cron')
}

/** Allow recovery of an existing routine by disabling it while preserving its stored timing. */
export function isSchedulePauseWithoutTimingChange(patch: { enabled?: boolean; cron?: string | null; runAt?: string | null; timezone?: string | null }): boolean {
    return patch.enabled === false && patch.cron === undefined && patch.runAt === undefined && patch.timezone === undefined
}
