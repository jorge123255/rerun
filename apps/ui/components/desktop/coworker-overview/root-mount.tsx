'use client'

import { DesktopCoworkerFilesBody } from '@/components/desktop/DesktopCoworkerFiles'
import { DesktopCoworkerDataBody } from '@/components/desktop/DesktopCoworkerData'
import { DesktopRunHistoryBody } from '@/components/desktop/DesktopRunHistory'
import { DesktopCoworkerMonitoringBody } from '@/components/desktop/DesktopCoworkerMonitoringBody'
import { DesktopCoworkerMcp } from '@/components/desktop/mcp/DesktopCoworkerMcp'
import { DesktopCoworkerSchedules } from '@/components/desktop/schedules/DesktopCoworkerSchedules'
import { DesktopCoworkerServices } from '@/components/desktop/services/DesktopCoworkerServices'
import { DesktopAgentPanelSetup } from '@/components/desktop/setup/DesktopAgentPanelSetup'
import { DesktopAgentPanelSkills } from '@/components/desktop/skills/DesktopAgentPanelSkills'
import { DesktopCoworkerTriggers } from '@/components/desktop/triggers/DesktopCoworkerTriggers'
import type { DesktopAgentView } from '@/components/desktop/DesktopApp'
import { decideDesktopOverviewWorkspaceSwitch, type DesktopOverviewFlush, type DesktopOverviewRunBoundary } from '@/lib/desktop/coworker-overview/workspace-switch'
import type { DesktopOverviewIdentity } from '@/lib/desktop/coworker-overview/identity'
import type { DesktopOverviewAcceptedPanelTab, DesktopOverviewTab } from '@/lib/desktop/coworker-overview/sections'
import type { DesktopPanelCloseGuard, RegisterDesktopPanelCloseGuard } from '@/lib/desktop/use-dialog-control'
import type { ReactNode, RefObject } from 'react'
import { DesktopCoworkerOverview } from './DesktopCoworkerOverview'
import type { DesktopOverviewComputer } from './DesktopCoworkerOverviewComputer'

export type DesktopCoworkerOverviewRootMountProps = {
    identity: DesktopOverviewIdentity
    agent: DesktopAgentView
    boxes: readonly { id: string; name: string }[] | null
    installAuthor?: boolean
    publishedAccess?: boolean
    canManage?: boolean | null
    phase?: 'ready' | 'loading' | 'error' | 'empty'
    error?: string
    servicesNeedConfig?: boolean | null
    needsMachineReason?: string | null
    settingsDisabledReason?: string | null
    computerEnabled?: boolean
    computer?: DesktopOverviewComputer
    working?: boolean
    mood?: 'asleep' | 'working' | 'idle'
    loadingSlot?: ReactNode
    focusSlug?: string | null
    onSkillFocusConsumed?: () => void
    onOpenSession?: (sessionId: string, title: string) => void
    onOpenAcceptedPanel?: (tab: DesktopOverviewAcceptedPanelTab) => void
    closeGuardRef?: RefObject<DesktopPanelCloseGuard | null>
    onClose: () => void
    onShare?: () => void
    onDelete?: (identity: DesktopOverviewIdentity, confirmationName: string) => void | Promise<void>
    onOpenComputer?: () => void
    onRenamed: (identity: DesktopOverviewIdentity, name: string) => void
}

/** Typed mount for the conversation shell. It does not edit that shell. */
export function DesktopCoworkerOverviewRootMount(props: DesktopCoworkerOverviewRootMountProps) {
    return (
        <DesktopCoworkerOverview
            identity={props.identity}
            agent={props.agent}
            boxes={props.boxes}
            installAuthor={props.installAuthor}
            publishedAccess={props.publishedAccess}
            canManage={props.canManage}
            phase={props.phase}
            error={props.error}
            servicesNeedConfig={props.servicesNeedConfig}
            needsMachineReason={props.needsMachineReason}
            settingsDisabledReason={props.settingsDisabledReason}
            computerEnabled={props.computerEnabled}
            computer={props.computer}
            working={props.working}
            mood={props.mood}
            loadingSlot={props.loadingSlot}
            onClose={props.onClose}
            onShare={props.onShare}
            onDelete={props.onDelete}
            onOpenComputer={props.onOpenComputer}
            onRenamed={props.onRenamed}
            onOpenAcceptedPanel={props.onOpenAcceptedPanel}
            closeGuardRef={props.closeGuardRef}
            renderTab={(tab, register) => overviewTab(tab, props, register)}
        />
    )
}

export function guardDesktopOverviewWorkspaceSwitch(input: {
    identity: DesktopOverviewIdentity
    targetWorkspaceId: number
    flush: DesktopOverviewFlush
    switchInFlight: boolean
    quitting: boolean
    runBoundary: DesktopOverviewRunBoundary
}) {
    return decideDesktopOverviewWorkspaceSwitch(input)
}

function overviewTab(tab: DesktopOverviewTab, props: DesktopCoworkerOverviewRootMountProps, register: RegisterDesktopPanelCloseGuard): ReactNode {
    if (tab === 'services') return <DesktopCoworkerServices agentId={props.agent.id} />
    if (tab === 'mcp') return <DesktopCoworkerMcp agentId={props.agent.id} />
    if (tab === 'skills') return <DesktopAgentPanelSkills agentId={props.agent.id} focusSlug={props.focusSlug} onFocusConsumed={props.onSkillFocusConsumed} />
    if (tab === 'scheduled' && props.onOpenSession) {
        const open = props.onOpenSession
        return <DesktopCoworkerSchedules agentId={props.agent.id} onOpenSession={chat => { if (chat.agentId === props.identity.agentId && chat.agentId === props.agent.id && chat.sessionId) open(chat.sessionId, chat.title) }} />
    }
    if (tab === 'triggers' && props.onOpenSession) {
        const open = props.onOpenSession
        return <DesktopCoworkerTriggers agentId={props.agent.id} ingressAvailable={false} onOpenSession={chat => { if (props.agent.id === props.identity.agentId && chat.sessionId) open(chat.sessionId, chat.title) }} />
    }
    if (tab === 'files') return <div className="flex min-h-0 flex-1 flex-col p-3">
        <DesktopCoworkerFilesBody key={props.agent.id} agent={props.agent} registerCloseGuard={register} />
    </div>
    if (tab === 'data') return <DesktopCoworkerDataBody key={props.agent.id} agentId={props.agent.id} />
    if (tab === 'logs') return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <DesktopRunHistoryBody key={props.agent.id} agentId={props.agent.id} />
    </div>
    if (tab === 'monitoring') return <DesktopCoworkerMonitoringBody agent={props.agent} />
    if (tab === 'setup' && props.installAuthor) return <DesktopAgentPanelSetup agentId={props.agent.id} />
    return undefined
}
