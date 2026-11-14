'use client'

import { ScheduledRunPresentation } from '@/components/chat/ScheduledRunPresentation'
import type { ScheduledRun } from '@/lib/schedules/scheduled-run'
import { DesktopWorkspaceMessage, type DesktopOpenWorkspaceFile } from './DesktopWorkspaceMessage'

export function DesktopScheduledRunBlock({ agentId, run, onOpenWorkspaceFile }: {
    agentId?: string
    run: ScheduledRun
    onOpenWorkspaceFile?: DesktopOpenWorkspaceFile
}) {
    return <ScheduledRunPresentation run={run}>
        <DesktopWorkspaceMessage agentId={agentId} onOpenWorkspaceFile={onOpenWorkspaceFile}>{run.prompt}</DesktopWorkspaceMessage>
    </ScheduledRunPresentation>
}
