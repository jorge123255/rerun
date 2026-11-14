import 'server-only'
import { soonestRoutine } from '@/lib/foreman/team-empty-state'
import { nextRunAt, routineFrequency } from '@/lib/schedules/cron'
import { byNextRun, type DesktopScheduledRun, type DesktopUpcomingRoutine, type DesktopScheduleRecord, type DesktopWorkspaceRoutine, type DesktopWorkspaceRoutineChat, type DesktopWorkspaceRoutineOwner, type DesktopWorkspaceRoutinesView } from '@rerun/contracts'

export type DesktopWorkspaceRoutinesAuthority = {
    listOwners: (signal?: AbortSignal) => Promise<readonly DesktopWorkspaceRoutineOwner[]>
    listSchedules: (owner: DesktopWorkspaceRoutineOwner, signal?: AbortSignal) => Promise<readonly DesktopScheduleRecord[]>
    listLatestRuns: (owner: DesktopWorkspaceRoutineOwner, signal?: AbortSignal) => Promise<readonly DesktopScheduledRun[]>
    adopt: (owner: DesktopWorkspaceRoutineOwner, run: DesktopScheduledRun, signal?: AbortSignal) => Promise<DesktopWorkspaceRoutineChat>
    canRename: (signal?: AbortSignal) => Promise<boolean>
}

export function createDesktopWorkspaceRoutinesReader(authority: DesktopWorkspaceRoutinesAuthority) {
    return {
        async upcoming(signal?: AbortSignal): Promise<DesktopUpcomingRoutine[]> {
            const owners = await authority.listOwners(signal)
            const schedules = await Promise.all(owners.filter(owner => owner.enabled && owner.scheduleGranted && !owner.setupPending)
                .map(async owner => ({ owner, schedules: await authority.listSchedules(owner, signal) })))
            signal?.throwIfAborted()
            const now = Date.now()
            return schedules.flatMap(({ owner, schedules }) => {
                const next = soonestRoutine(schedules.map(schedule => ({ ...schedule, lastRunAt: schedule.lastRunAt ?? null })), now)
                return next ? [{ agentId: owner.agentId, ...next }] : []
            })
        },
        async list(signal?: AbortSignal): Promise<DesktopWorkspaceRoutinesView> {
            const now = new Date()
            const owners = await authority.listOwners(signal)
            const perOwner = await Promise.allSettled(owners.filter(owner => owner.enabled).map(async owner => {
                const [schedules, runs] = await Promise.all([authority.listSchedules(owner, signal), authority.listLatestRuns(owner, signal)])
                return Promise.all(schedules.map(async schedule => {
                    const history = runs.filter(run => run.agentId === owner.agentId && run.triggerSource === 'schedule' && run.triggerSlug === schedule.slug)
                        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
                    const last = history[0]
                    const running = history.find(run => run.status === 'running')
                    const routine: DesktopWorkspaceRoutine = {
                        ...schedule,
                        agentId: schedule.agentId,
                        slug: schedule.slug,
                        name: schedule.name,
                        enabled: schedule.enabled,
                        revision: schedule.revision,
                        frequency: routineFrequency(schedule),
                        nextRunAt: nextRunAt({ ...schedule, lastRunAt: schedule.lastRunAt ?? null }, now),
                        runningSince: running?.startedAt ?? null,
                        setupPending: owner.setupPending,
                        ...(schedule.lastRunAt !== undefined ? { lastRunAt: schedule.lastRunAt } : {}),
                        ...(last ? { lastResult: { status: last.status, runId: last.id, chat: await authority.adopt(owner, last, signal) } } : {}),
                    }
                    return routine
                }))
            }))
            signal?.throwIfAborted()
            const failures = perOwner.filter((row): row is PromiseRejectedResult => row.status === 'rejected')
            if (failures.length) throw new AggregateError(failures.map(row => row.reason), 'Some coworker routines could not be read. Refresh before making changes.')
            return {
                routines: perOwner.flatMap(result => result.status === 'fulfilled' ? result.value : []).sort(byNextRun),
                canRename: await authority.canRename(signal),
            }
        },
    }
}
