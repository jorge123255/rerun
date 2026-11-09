import { Cron } from 'croner'
import { z } from 'zod'

export type DesktopScheduleSelection =
    | { mode: 'cron'; cron: string; runAt: null; timezone: string }
    | { mode: 'runAt'; cron: null; runAt: string; timezone: string }
export type DesktopSchedulePreview = { selection: DesktopScheduleSelection; label: string }
export type DesktopScheduleParseResult =
    | { status: 'ok'; value: unknown }
    | { status: 'invalid' | 'unavailable'; message: string }
export type DesktopScheduleParser = (input: { description: string; nowIso: string; timezone: string; signal: AbortSignal }) => Promise<DesktopScheduleParseResult>

export const DESKTOP_SCHEDULE_UNAVAILABLE = 'Natural-language schedule parsing is unavailable in this build. Enter cron or an ISO time manually.'
export async function unavailableDesktopScheduleParser(_input: Parameters<DesktopScheduleParser>[0]): Promise<DesktopScheduleParseResult> {
    return { status: 'unavailable', message: DESKTOP_SCHEDULE_UNAVAILABLE }
}

const candidateSchema = z.object({
    mode: z.enum(['cron', 'runAt']),
    cron: z.string().trim().max(120).nullish(),
    runAt: z.string().trim().max(80).nullish(),
    timezone: z.string().trim().min(1).max(100).nullish(),
    label: z.string().trim().max(200).optional(),
}).strict()

function validTimezone(value: string): boolean {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}

export function validateDesktopSchedulePreview(value: unknown, currentTimezone: string): DesktopSchedulePreview | null {
    const candidate = candidateSchema.safeParse(value)
    if (!candidate.success) return null
    const data = candidate.data
    const timezone = data.timezone ?? currentTimezone
    if (!validTimezone(timezone)) return null
    if (data.mode === 'cron') {
        if (!data.cron || data.runAt) return null
        try { new Cron(data.cron, { timezone }).nextRun() } catch { return null }
        return { selection: { mode: 'cron', cron: data.cron, runAt: null, timezone }, label: data.label || data.cron }
    }
    if (!data.runAt || data.cron || !z.string().datetime({ offset: true }).safeParse(data.runAt).success) return null
    return { selection: { mode: 'runAt', cron: null, runAt: data.runAt, timezone }, label: data.label || data.runAt }
}
