import { readDesktopTeamSchedules, readDesktopTeamTriggers } from '../team-reads/adapters.js'
import { desktopTeamDirectory } from '../team-reads/directory.js'
import type { DesktopTeamDirectory } from '../team-reads/ports.js'
import type { ForemanWorkspaceReadPorts, ForemanWorkspaceScheduleRow, ForemanWorkspaceTriggerRow } from './ports.js'
import type { DesktopTeamReadAck } from '../team-reads/ports.js'

export function createDesktopForemanWorkspacePorts(input: {
    grant: (workspaceId: string) => Promise<boolean>
    snapshot: ForemanWorkspaceReadPorts['snapshot']
    directory?: Pick<DesktopTeamDirectory, 'members' | 'lookup'>
    schedules?: (engineAgentId: string) => Promise<DesktopTeamReadAck<ForemanWorkspaceScheduleRow[]>>
    triggers?: (engineAgentId: string) => Promise<DesktopTeamReadAck<ForemanWorkspaceTriggerRow[]>>
}): ForemanWorkspaceReadPorts {
    return {
        grant: input.grant,
        snapshot: input.snapshot,
        directory: input.directory ?? desktopTeamDirectory(),
        schedules: input.schedules ?? readDesktopTeamSchedules,
        triggers: input.triggers ?? readDesktopTeamTriggers,
    }
}
