import { teamEmptyStateOf as teamEmptyStateFor, type TeamAgent, type TeamEmptyStateModel, type TeamPulse } from '@rerun/contracts'

import type { AgentSchedule } from '@/lib/board/next-runs'
import { nextRunAt } from '@/lib/schedules/cron'

export type { TeamEmptyStateAction, TeamEmptyStateModel, TeamEmptyStateRow, TeamPulse } from '@rerun/contracts'

export function soonestRoutine(schedules: readonly Pick<AgentSchedule, 'name' | 'enabled' | 'cron' | 'runAt' | 'timezone' | 'lastRunAt'>[], now: number): TeamPulse['nextRoutine'] {
    const at = new Date(now)
    let soonest: TeamPulse['nextRoutine'] = null
    for (const schedule of schedules) {
        const next = nextRunAt(schedule, at)
        const due = next ? new Date(next).getTime() : null
        // A one-shot keeps its date until the engine marks it fired, a tick after it is due.
        if (due == null || !Number.isFinite(due) || due <= now) continue
        if (!soonest || due < soonest.at) soonest = { name: schedule.name, at: due }
    }
    return soonest
}

export function teamEmptyStateOf({ agents, schedules, firstName, now }: { agents: TeamAgent[]; schedules: AgentSchedule[]; firstName: string; now: number }): TeamEmptyStateModel {
    return teamEmptyStateFor({ agents, firstName, nextRoutine: soonestRoutine(schedules, now) })
}
