import type { DesktopForemanBinding, ForemanWorkspaceSnapshot } from '@rerun/contracts'
import type { DesktopTeamDirectory, DesktopTeamReadAck, DesktopTeamScheduleView, DesktopTeamTriggerView } from '../team-reads/ports.js'

export type ForemanWorkspaceScheduleRow = Parameters<typeof import('../team-reads/project.js').desktopTeamScheduleView>[0]
export type ForemanWorkspaceTriggerRow = Parameters<typeof import('../team-reads/project.js').desktopTeamTriggerView>[0]

export type ForemanWorkspaceReadContext = {
    binding: DesktopForemanBinding
    assertCurrent: () => Promise<void>
    signal: AbortSignal
}

export type ForemanWorkspaceReadPorts = {
    grant(workspaceId: string): Promise<boolean>
    snapshot(binding: DesktopForemanBinding, signal: AbortSignal): Promise<ForemanWorkspaceSnapshot>
    directory: Pick<DesktopTeamDirectory, 'members' | 'lookup'>
    schedules(engineAgentId: string): Promise<DesktopTeamReadAck<ForemanWorkspaceScheduleRow[]>>
    triggers(engineAgentId: string): Promise<DesktopTeamReadAck<ForemanWorkspaceTriggerRow[]>>
}

export type { DesktopTeamScheduleView, DesktopTeamTriggerView }
