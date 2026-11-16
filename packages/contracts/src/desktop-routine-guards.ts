import { z } from 'zod'
import { desktopRoutineRunOutcomeSchema } from './desktop-routine-checklist.js'

// Limits that keep routines on the Mac from running away. The three limits come from
// CopilotKit/OpenBot's docs/routines.md (MIT); the code here is Rerun's own.
export const ROUTINE_MIN_INTERVAL_MINUTES = 15
export const ROUTINE_MAX_ENABLED = 20
export const ROUTINE_FAILURES_BEFORE_OFF = 10

export const ROUTINE_GUARD_MESSAGES = {
    interval: `A recurring routine can run at most once every ${ROUTINE_MIN_INTERVAL_MINUTES} minutes. Choose a slower schedule; nothing was saved.`,
    cap: `This workspace already has ${ROUTINE_MAX_ENABLED} routines turned on. Turn one off before turning on another; nothing was saved.`,
    autoOff: `This routine was turned off after failing ${ROUTINE_FAILURES_BEFORE_OFF} times in a row. Switch it back on in the coworker’s Routines once the cause is fixed.`,
} as const

export type RoutineGuardKind = 'interval' | 'cap'
/** The engine answers a refused save with this status and `{ error, code }`. */
export const ROUTINE_GUARD_STATUS = 422
export const ROUTINE_GUARD_CODE = 'routine_guard'

type Shape = { enabled: boolean; cron: string | null }

/** How many firings ahead are compared. Uneven crons ("0,5 9 * * *") show their short gap early. */
const SAMPLES = 120

/** True when two consecutive firings are closer than the minimum interval. */
export function routineFiresTooOften(next: (from: Date) => Date | null, from: Date): boolean {
    let last = next(from)
    for (let index = 0; last && index < SAMPLES; index += 1) {
        const following = next(last)
        if (!following) return false
        if (following.getTime() - last.getTime() < ROUTINE_MIN_INTERVAL_MINUTES * 60_000) return true
        last = following
    }
    return false
}

/** The interval is checked on a new routine, a changed cron, and a routine being switched on. */
export function routineIntervalChecked(before: Shape | null, after: Shape): boolean {
    if (!after.cron) return false
    return !before || before.cron !== after.cron || (!before.enabled && after.enabled)
}

/** The cap is checked whenever a routine goes from off (or absent) to on. */
export function routineCapChecked(before: Shape | null, after: Shape): boolean {
    return after.enabled && !before?.enabled
}

export function routineGuardRefusal(input: { before: Shape | null; after: Shape; tooOften: () => boolean; enabledElsewhere: number }): RoutineGuardKind | null {
    if (routineIntervalChecked(input.before, input.after) && input.tooOften()) return 'interval'
    if (routineCapChecked(input.before, input.after) && input.enabledElsewhere >= ROUTINE_MAX_ENABLED) return 'cap'
    return null
}

/** A plain refusal out of an engine error body, or null when the engine refused for another reason. */
export function routineGuardMessageOf(body: string): string | null {
    const start = body.indexOf('{')
    if (start < 0) return null
    try {
        const parsed = z.object({ error: z.string().min(1).max(500), code: z.literal(ROUTINE_GUARD_CODE) }).safeParse(JSON.parse(body.slice(start)))
        return parsed.success ? parsed.data.error : null
    } catch { return null }
}

export const desktopRoutineWarningSchema = z.enum(['interval', 'cap'])
export type DesktopRoutineWarning = z.infer<typeof desktopRoutineWarningSchema>

export const desktopRoutineHealthSchema = z.object({
    limit: z.number().int(),
    enabledInWorkspace: z.number().int().min(0),
    routines: z.array(z.object({
        slug: z.string().min(1).max(160),
        /** Saved before the limits existed, or by hand: it keeps running and shows a warning. */
        warnings: z.array(desktopRoutineWarningSchema).max(2),
        consecutiveFailures: z.number().int().min(0),
        /** Set when the routine was switched off after too many failures; cleared when it is switched on. */
        autoDisabledAt: z.string().max(64).nullable(),
        lastOutcome: desktopRoutineRunOutcomeSchema.extend({ runId: z.string().min(1).max(160) }).nullable(),
    }).strict()).max(2000),
}).strict()
export type DesktopRoutineHealth = z.infer<typeof desktopRoutineHealthSchema>
