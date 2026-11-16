import { HttpError } from '../lib/errors.js'
import { DesktopPlanOutError, UsageWaitError } from './usage-gate.js'

/**
 * Why a routine's firing ended before a run started (Mac app), and whether that counts toward the
 * ten failures in a row that switch a routine off. Decided November 16, 2026.
 *
 * Counted: a standing fault of the routine or its coworker, which will fail the same way at every
 * firing until somebody fixes it. Not counted: the person's own choice, a plan out of usage, an
 * occurrence that was skipped, or the app going away. Anything the scheduler did not name is
 * `unclassified` and is not counted.
 */
export const ROUTINE_START_FAILURES = {
    /** The model saved on the routine is incomplete or can no longer run. */
    'saved-model': true,
    /** The provider is not connected (a preset no connected plan answers) or the desktop policy refuses it. */
    provider: true,
    /** The coworker's setup is still pending. */
    'setup-pending': true,
    /** Preparing the run threw: its conversation or its run record could not be created. */
    preparation: true,
    /** Parked by the usage-limit gate, or refused for usage or budget. */
    usage: false,
    /** A hand-started "Run now" or test run. */
    manual: false,
    /** A parked occurrence the usage gate ran again; it goes back to waiting when it cannot start. */
    'usage-resume': false,
    /** The coworker is switched off. */
    'coworker-off': false,
    /** The routine is paused. */
    paused: false,
    /** The occurrence was already claimed, is already running, or is no longer due. */
    skipped: false,
    /** The routine or the coworker was edited or deleted while the firing was being prepared. */
    changed: false,
    /** The app refused or could not answer: schedules not granted, coworker being deleted, conversation not adopted. */
    authorization: false,
    /** The app, the engine or the workspace is shutting down or switching. */
    shutdown: false,
    /** The run did start, or failed inside its own preparation: its terminal already settled the count. */
    'inside-run': false,
    /** A path nobody named. */
    unclassified: false,
} as const satisfies Record<string, boolean>

export type RoutineStartFailure = keyof typeof ROUTINE_START_FAILURES

const named = new WeakMap<object, RoutineStartFailure>()

/** Names why this error ended the firing. The first name given stays, unless `replace` is set. */
export function nameRoutineStartFailure<T>(error: T, kind: RoutineStartFailure, replace = false): T {
    if (typeof error === 'object' && error !== null && (replace || !named.has(error))) named.set(error, kind)
    return error
}

/** Runs one step of a launch; an error it throws is named `kind` when `when` agrees and nothing named it first. */
export async function routineStartStep<T>(kind: RoutineStartFailure, work: () => T | Promise<T>, when: (error: unknown) => boolean = () => true): Promise<T> {
    try { return await work() }
    catch (error) { throw when(error) ? nameRoutineStartFailure(error, kind) : error }
}

export const isConflict = (error: unknown) => error instanceof HttpError && error.status === 409

export function classifyRoutineStartFailure(input: {
    error: unknown
    /** The scheduler's own tick fired it, as opposed to "Run now" or the usage gate's second try. */
    scheduled: boolean
    usageResume?: boolean
    /** The scheduler is still running and the workspace is not switching. */
    active: boolean
}): RoutineStartFailure {
    if (!input.scheduled) return input.usageResume ? 'usage-resume' : 'manual'
    if (!input.active) return 'shutdown'
    const { error } = input
    if (error instanceof UsageWaitError || error instanceof DesktopPlanOutError || (error instanceof HttpError && error.status === 402)) return 'usage'
    return (typeof error === 'object' && error !== null ? named.get(error) : undefined) ?? 'unclassified'
}

export function routineStartFailureCounts(kind: RoutineStartFailure): boolean {
    return ROUTINE_START_FAILURES[kind]
}
