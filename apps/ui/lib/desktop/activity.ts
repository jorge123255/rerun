import { z } from 'zod'
import { DESKTOP_ACTIVITY_OUTCOMES, DESKTOP_ACTIVITY_SOURCES, DESKTOP_CONNECTOR_ACTION_KINDS } from '@rerun/contracts'

/** One row of the Activity view: a trail record with the coworker and conversation it belongs to on this Mac. */
export const desktopActivityRowSchema = z.object({
    seq: z.number().int(),
    id: z.string(),
    at: z.string(),
    coworker: z.string(),
    /** The coworker's id in the app, or null once it has been deleted. */
    coworkerId: z.string().nullable(),
    deleted: z.boolean(),
    /** The saved conversation the action happened in, when it is still on this Mac. */
    conversationId: z.string().nullable(),
    sentence: z.string(),
    outcome: z.enum(DESKTOP_ACTIVITY_OUTCOMES),
    ruleWords: z.string(),
    tool: z.string(),
    action: z.string().nullable(),
    app: z.string().nullable(),
    kind: z.enum(DESKTOP_CONNECTOR_ACTION_KINDS).nullable(),
    source: z.enum(DESKTOP_ACTIVITY_SOURCES),
    sourceSlug: z.string().nullable(),
    durationMs: z.number().nullable(),
    summary: z.string().nullable(),
})
export type DesktopActivityRow = z.infer<typeof desktopActivityRowSchema>

export const desktopActivityViewSchema = z.object({
    rows: z.array(desktopActivityRowSchema),
    next: z.number().int().nullable(),
    total: z.number().int(),
    dropped: z.number().int(),
    coworkers: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type DesktopActivityView = z.infer<typeof desktopActivityViewSchema>

export type DesktopActivityViewFilters = {
    /** A coworker's id, `deleted` for coworkers that no longer exist, or empty for everyone. */
    coworker: string
    outcome: string
    source: string
    risky: boolean
    /** Local calendar days, as a date field gives them: `2026-11-16`. */
    from: string
    to: string
    search: string
}

export const EMPTY_ACTIVITY_FILTERS: DesktopActivityViewFilters = { coworker: '', outcome: '', source: '', risky: false, from: '', to: '', search: '' }

/** The query string the view's filters travel as. Days become the moments they start and end on this Mac. */
export function desktopActivityQuery(filters: DesktopActivityViewFilters, before?: number | null): string {
    const query = new URLSearchParams()
    if (filters.coworker) query.set('coworker', filters.coworker)
    if (filters.outcome) query.set('outcome', filters.outcome)
    if (filters.source) query.set('source', filters.source)
    if (filters.risky) query.set('risky', '1')
    const day = (value: string, end: boolean) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
        if (!match) return null
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0)
        return Number.isFinite(date.getTime()) ? date.toISOString() : null
    }
    const from = day(filters.from, false), to = day(filters.to, true)
    if (from) query.set('from', from)
    if (to) query.set('to', to)
    if (filters.search.trim()) query.set('q', filters.search.trim().slice(0, 100))
    if (before) query.set('before', String(before))
    return query.toString()
}

/** Saves the current filter as a CSV file through the browser's own download, as table exports do. */
export async function downloadDesktopActivityCsv(filters: DesktopActivityViewFilters, signal: AbortSignal): Promise<void> {
    const response = await fetch(`/api/desktop/activity/export?${desktopActivityQuery(filters)}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error('Could not export the activity. Try again.')
    const objectUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `rerun-activity-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.append(anchor)
    try { signal.throwIfAborted(); anchor.click() }
    finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000) }
}
