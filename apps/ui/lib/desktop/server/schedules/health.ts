import 'server-only'
import { desktopRoutineHealthSchema, routineGuardMessageOf, ROUTINE_GUARD_STATUS, type DesktopRoutineHealth, type DesktopRoutineRunOutcome, type DesktopRoutineWarning } from '@rerun/contracts'
import type { EngineConnection } from '@/lib/engine/types'
import { request, EngineRequestError } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'

/**
 * What the routine lists show beside a routine: limits it already breaks, whether repeated failures
 * switched it off, and what its last run reported. It decorates the list, so a failed read leaves
 * the list as it was instead of hiding the routines.
 */
export async function readDesktopRoutineHealth(engine: EngineConnection, engineAgentId: string, signal?: AbortSignal): Promise<DesktopRoutineHealth | null> {
    try {
        return await request(engine, `/desktop/workspace-routines/${encodeURIComponent(engineAgentId)}/health`, { method: 'GET', signal, cache: 'no-store' }, value => desktopRoutineHealthSchema.parse(value))
    } catch {
        signal?.throwIfAborted()
        return null
    }
}

export type DesktopRoutineHealthFields = { warnings: DesktopRoutineWarning[]; autoDisabledAt: string | null; outcome?: DesktopRoutineRunOutcome }

/** The fields one routine row gains. The outcome is attached only to the run it belongs to. */
export function desktopRoutineHealthFields(health: DesktopRoutineHealth | null, slug: string, lastRunId: string | undefined): DesktopRoutineHealthFields {
    const row = health?.routines.find(routine => routine.slug === slug)
    if (!row) return { warnings: [], autoDisabledAt: null }
    const last = row.lastOutcome
    if (!last || last.runId !== lastRunId) return { warnings: row.warnings, autoDisabledAt: row.autoDisabledAt }
    return { warnings: row.warnings, autoDisabledAt: row.autoDisabledAt, outcome: { quiet: last.quiet, test: last.test, checklist: last.checklist } }
}

/** The engine's plain refusal of a save that would break a routine limit, as the app's own error. */
export function routineGuardRefusalOf(error: unknown): DesktopHttpError | null {
    if (!(error instanceof EngineRequestError) || error.status !== ROUTINE_GUARD_STATUS) return null
    const message = routineGuardMessageOf(error.message)
    return message ? new DesktopHttpError(ROUTINE_GUARD_STATUS, message) : null
}
