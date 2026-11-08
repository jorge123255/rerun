import { Cron } from 'croner'
import type { Schedule } from './loader.js'
import { nextCronRun } from './next-run.js'

export function isValidCron(expr: string): boolean {
    try {
        new Cron(expr)
        return true
    } catch {
        return false
    }
}

export function isDue(schedule: Schedule, now: Date): boolean {
    if (!schedule.enabled) return false
    if (schedule.runAt) {
        if (schedule.lastRunAt) return false
        return now.getTime() >= new Date(schedule.runAt).getTime()
    }
    if (!schedule.cron) return false
    const baseline = schedule.lastRunAt ?? schedule.createdAt
    const next = nextCronRun({ cron: schedule.cron, timezone: schedule.timezone }, baseline ? new Date(baseline) : now)
    return Boolean(next && next.getTime() <= now.getTime())
}

export function nextRunAt(schedule: Schedule, now: Date): string | null {
    if (!schedule.enabled) return null
    if (schedule.runAt) return schedule.lastRunAt ? null : schedule.runAt
    if (!schedule.cron) return null
    const next = nextCronRun({ cron: schedule.cron, timezone: schedule.timezone }, now)
    return next ? next.toISOString() : null
}
