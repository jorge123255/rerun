import { ROUTINE_GUARD_CODE, ROUTINE_GUARD_MESSAGES, ROUTINE_GUARD_STATUS, ROUTINE_MAX_ENABLED, routineFiresTooOften, routineGuardRefusal, type DesktopRoutineWarning, type RoutineGuardKind } from '@rerun/contracts'
import type { Context } from 'hono'
import { listAgentIdsOnDisk } from '../agents/loader.js'
import { listSchedules } from '../schedules/loader.js'
import { nextCronRun } from '../schedules/next-run.js'
import { desktopDeletionPending } from './agent-lifecycle.js'

type Shape = { enabled: boolean; cron: string | null; timezone: string | null }

export function desktopRoutineTooFrequent(schedule: Pick<Shape, 'cron' | 'timezone'>, now: Date): boolean {
    const cron = schedule.cron
    if (!cron) return false
    return routineFiresTooOften(from => nextCronRun({ cron, timezone: schedule.timezone }, from), now)
}

/** Every enabled routine of every coworker in this Mac's workspace. A coworker being deleted no longer counts. */
export async function listEnabledDesktopRoutines(): Promise<{ agentId: string; slug: string }[]> {
    const enabled: { agentId: string; slug: string }[] = []
    for (const agentId of await listAgentIdsOnDisk()) {
        if (desktopDeletionPending(agentId)) continue
        const schedules = await listSchedules(agentId).catch(() => [])
        for (const schedule of schedules) if (schedule.enabled) enabled.push({ agentId, slug: schedule.slug })
    }
    return enabled
}

export type DesktopRoutineGuard = (agentId: string, slug: string, before: Shape | null, after: Shape | null) => Promise<RoutineGuardKind | null>

/**
 * The two save-time limits: a recurring routine fires at most every fifteen minutes, and a workspace
 * holds at most twenty enabled routines. Only a change that would newly break a limit is refused, so
 * a routine saved before the limits can still be edited, paused or deleted.
 */
export function createDesktopRoutineGuard(deps: { listEnabled?: () => Promise<{ agentId: string; slug: string }[]>; now?: () => Date } = {}): DesktopRoutineGuard {
    const listEnabled = deps.listEnabled ?? listEnabledDesktopRoutines
    return async (agentId, slug, before, after) => {
        if (!after) return null
        const now = deps.now?.() ?? new Date()
        // Counted only when the cap is in play, so an ordinary edit never walks every coworker.
        const elsewhere = after.enabled && !before?.enabled
            ? (await listEnabled()).filter(row => !(row.agentId === agentId && row.slug === slug)).length : 0
        return routineGuardRefusal({ before, after, tooOften: () => desktopRoutineTooFrequent(after, now), enabledElsewhere: elsewhere })
    }
}

export const desktopRoutineGuard: DesktopRoutineGuard = (agentId, slug, before, after) => createDesktopRoutineGuard()(agentId, slug, before, after)

/** The answer a route gives a refused save: its own status and code, so the app can show the plain message. */
export function desktopRoutineGuardResponse(c: Context, guard: RoutineGuardKind) {
    return c.json({ error: ROUTINE_GUARD_MESSAGES[guard], code: ROUTINE_GUARD_CODE }, ROUTINE_GUARD_STATUS)
}

/** Limits a saved routine already breaks. It keeps running and the app shows these. */
export function desktopRoutineWarnings(schedule: Shape, enabledInWorkspace: number, now: Date): DesktopRoutineWarning[] {
    const warnings: DesktopRoutineWarning[] = []
    if (schedule.enabled && desktopRoutineTooFrequent(schedule, now)) warnings.push('interval')
    if (schedule.enabled && enabledInWorkspace > ROUTINE_MAX_ENABLED) warnings.push('cap')
    return warnings
}
