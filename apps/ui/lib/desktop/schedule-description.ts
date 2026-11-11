import { Cron } from 'croner'
import { z } from 'zod'
import { desktopProvider } from './settings'

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

export function validateDesktopSchedulePreview(value: unknown, currentTimezone: string, now = Date.now()): DesktopSchedulePreview | null {
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
    if (!data.runAt || data.cron || !z.string().datetime({ offset: true }).safeParse(data.runAt).success || Date.parse(data.runAt) <= now) return null
    return { selection: { mode: 'runAt', cron: null, runAt: data.runAt, timezone }, label: data.label || data.runAt }
}


export const desktopScheduleDescriptionRequestSchema = z.object({
    description: z.string().trim().min(1).max(1000),
    nowIso: z.string().datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(100),
    connectionId: z.string().trim().min(1).max(256).nullable().default(null),
    provider: desktopProvider.nullable().default(null),
    model: z.string().trim().min(1).max(256).nullable().default(null),
    slug: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/).optional(),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, ctx) => {
    const fields = [value.connectionId, value.provider, value.model]
    if (value.slug || value.expectedRevision) {
        if (!value.slug || !value.expectedRevision || fields.some(field => field !== null)) {
            ctx.addIssue({ code: 'custom', message: 'Choose the saved routine revision without a model override' })
        }
        return
    }
    if (fields.every(field => field === null) || fields.every(field => field !== null)) return
    ctx.addIssue({ code: 'custom', message: 'Choose a connected provider and model, or follow the coworker default' })
})

export const desktopScheduleParseResultSchema = z.union([
    z.object({ status: z.literal('ok'), value: z.unknown() }).strict(),
    z.object({ status: z.enum(['invalid', 'unavailable']), message: z.string().max(300) }).strict(),
])
export const DESKTOP_SCHEDULE_PARSER_UNAVAILABLE = 'The local schedule parser is unavailable. Enter cron or an ISO time manually.'
export const DESKTOP_SCHEDULE_PARSER_INVALID = 'The local schedule parser returned an invalid response. Enter cron or an ISO time manually.'

export function createDesktopScheduleParser(selection: { agentId: string; connectionId: string | null; provider: z.infer<typeof desktopProvider> | null; model: string | null; slug?: string; expectedRevision?: string }): DesktopScheduleParser {
    return async input => {
        try {
            const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(selection.agentId)}/schedule-description`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error',
                body: JSON.stringify({ description: input.description, nowIso: input.nowIso, timezone: input.timezone,
                    connectionId: selection.connectionId, provider: selection.provider, model: selection.model, slug: selection.slug, expectedRevision: selection.expectedRevision }),
                signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) return { status: 'unavailable', message: DESKTOP_SCHEDULE_PARSER_UNAVAILABLE }
            const parsed = desktopScheduleParseResultSchema.safeParse(body)
            return parsed.success ? parsed.data : { status: 'invalid', message: DESKTOP_SCHEDULE_PARSER_INVALID }
        } catch (error) {
            if (input.signal.aborted) throw error
            return { status: 'unavailable', message: DESKTOP_SCHEDULE_PARSER_UNAVAILABLE }
        }
    }
}
