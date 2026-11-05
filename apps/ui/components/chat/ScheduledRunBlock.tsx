'use client'

import { AgentWorkspaceMessage } from '@/components/chat/AgentWorkspaceMessage'
import { ScheduledRunPresentation } from '@/components/chat/ScheduledRunPresentation'
import type { ScheduledRun } from '@/lib/schedules/scheduled-run'

// The routine speaks, not the user: a divider marks where it fired, its prompt one click away.
export function ScheduledRunBlock({ agentId, run }: { agentId: string | undefined; run: ScheduledRun }) {
    return <ScheduledRunPresentation run={run}>
        <AgentWorkspaceMessage agentId={agentId}>{run.prompt}</AgentWorkspaceMessage>
    </ScheduledRunPresentation>
}
