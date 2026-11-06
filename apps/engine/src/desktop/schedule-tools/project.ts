import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M } from '@rerun/contracts'
import { nextRunAt } from '../../schedules/cron.js'
import type { Schedule } from '../../schedules/loader.js'
import { desktopScheduleDefinitionRevision } from './revision.js'
import type { DesktopScheduleDefinition } from './types.js'

function asSchedule(schedule: DesktopScheduleDefinition): Schedule {
    return schedule as Schedule
}

export function projectScheduleList(schedules: DesktopScheduleDefinition[], now: Date): string {
    if (schedules.length === 0) return M.empty
    return schedules.map(schedule => {
        const trigger = schedule.cron ? `cron ${schedule.cron}` : `once ${schedule.runAt}`
        const state = schedule.enabled ? `next ${nextRunAt(asSchedule(schedule), now) ?? 'never'}` : 'disabled'
        return `- ${schedule.name} (${schedule.slug}): ${trigger}, ${state}`
    }).join('\n')
}

export function projectScheduleGet(schedule: DesktopScheduleDefinition, now: Date): string {
    const lines = [
        `${schedule.name} (${schedule.slug})`,
        schedule.description ? `Description: ${schedule.description}` : '',
        schedule.cron ? `Cron: ${schedule.cron}` : `Runs once at: ${schedule.runAt}`,
        schedule.timezone ? `Timezone: ${schedule.timezone}` : '',
        `Enabled: ${schedule.enabled}`,
        `Revision: ${desktopScheduleDefinitionRevision(schedule)}`,
        schedule.enabled ? `Next run: ${nextRunAt(asSchedule(schedule), now) ?? 'never'}` : '',
        schedule.lastRunAt ? `Last run: ${schedule.lastRunAt}` : '',
        schedule.model ? `Model: ${schedule.model}${schedule.provider ? ` (${schedule.provider})` : ''}` : '',
        '',
        schedule.body,
    ]
    return lines.filter(line => line !== '').join('\n')
}
