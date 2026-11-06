import 'server-only'
import { nextRunAt, routineFrequency } from '@/lib/schedules/cron'
import { byNextRun, type DesktopScheduledRun, type DesktopScheduleRecord, type DesktopWorkspaceRoutine, type DesktopWorkspaceRoutineChat, type DesktopWorkspaceRoutineOwner, type DesktopWorkspaceRoutinesView } from '../../../../../../packages/contracts/src/desktop-workspace-routines'

export type DesktopWorkspaceRoutinesAuthority = {
    listOwners: (signal?: AbortSignal) => Promise<readonly DesktopWorkspaceRoutineOwner[]>
    listSchedules: (owner: DesktopWorkspaceRoutineOwner, signal?: AbortSignal) => Promise<readonly DesktopScheduleRecord[]>
    listRuns: (owner: DesktopWorkspaceRoutineOwner, signal?: AbortSignal) => Promise<readonly DesktopScheduledRun[]>
    adopt: (owner: DesktopWorkspaceRoutineOwner, run: DesktopScheduledRun, signal?: AbortSignal) => Promise<DesktopWorkspaceRoutineChat>
    canRename: (signal?: AbortSignal) => Promise<boolean>
}

export function createDesktopWorkspaceRoutinesReader(authority: DesktopWorkspaceRoutinesAuthority) {
    return {
        async list(signal?: AbortSignal): Promise<DesktopWorkspaceRoutinesView> {
            const now = new Date()
            const owners = await authority.listOwners(signal)
            const perOwner = await Promise.allSettled(owners.filter(owner => owner.enabled).map(async owner => {
                const [schedules, runs] = await Promise.all([authority.listSchedules(owner, signal), authority.listRuns(owner, signal)])
                return Promise.all(schedules.map(async schedule => {
                    const history = runs.filter(run => run.triggerSource === 'schedule' && run.triggerSlug === schedule.slug)
                        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
                    const last = history[0]
                    const running = history.find(run => run.status === 'running')
                    const routine: DesktopWorkspaceRoutine = {
                        agentId: schedule.agentId,
                        slug: schedule.slug,
                        name: schedule.name,
                        enabled: schedule.enabled,
                        revision: schedule.revision,
                        frequency: routineFrequency(schedule),
                        nextRunAt: nextRunAt(schedule, now),
                        runningSince: running?.startedAt ?? null,
                        setupPending: owner.setupPending,
                        ...(schedule.lastRunAt !== undefined ? { lastRunAt: schedule.lastRunAt } : {}),
                        ...(last ? { lastResult: { status: last.status, runId: last.id, chat: await authority.adopt(owner, last, signal) } } : {}),
                    }
                    return routine
                }))
            }))
            return {
                routines: perOwner.flatMap(result => result.status === 'fulfilled' ? result.value : []).sort(byNextRun),
                canRename: await authority.canRename(signal),
            }
        },
    }
}
