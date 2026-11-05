'use client'

import { ElapsedTime } from '@/components/chat/ElapsedTime'
import { StepRow } from '@/components/chat/StepRow'
import { ToolOutput, ToolSection } from '@/components/chat/ToolCallBlock'
import { useToolDisplay } from '@/hooks/useToolDisplay'
import { isSubRunLive, subRunHeadline } from '@/lib/chat/sub-run-progress'
import { ToolCallRow, type ToolCallStatus } from '@rerun/ui/chat'
import { useEffect, useRef, useState } from 'react'
import type { DesktopDelegationSnapshot } from '../../../../../packages/contracts/src/desktop-delegation'
import { DesktopDelegationTree } from './DesktopDelegationTree'
import { delegationTaskToSubRun } from './task-view'

const DELEGATE_TOOL = 'delegate_tasks'

export type DesktopDelegationBlockProps = {
    snapshot: DesktopDelegationSnapshot
    agentId?: string
    output?: unknown
    errorText?: string
    onStopTask?: (taskId: string) => Promise<void>
    dense?: boolean
}

export function DesktopDelegationBlock({ snapshot, agentId, output, errorText, onStopTask, dense = false }: DesktopDelegationBlockProps) {
    const toolDisplay = useToolDisplay(agentId)
    const { iconProps } = toolDisplay(DELEGATE_TOOL)
    const tasks = snapshot.tasks.map(delegationTaskToSubRun)
    const live = tasks.some(isSubRunLive)
    const { label, summary } = subRunHeadline({ kind: 'delegate', tasks }, live, DELEGATE_TOOL)
    const [open, setOpen] = useState(live)
    const wasLive = useRef(live)
    useEffect(() => {
        if (wasLive.current && !live) setOpen(false)
        wasLive.current = live
    }, [live])

    const everyTaskFailed = tasks.length > 0 && tasks.every(task => task.status === 'error')
    const status: ToolCallStatus = live ? 'running' : everyTaskFailed ? 'error' : errorText ? 'error' : 'done'
    const details = (
        <>
            <DesktopDelegationTree tasks={snapshot.tasks} toolDisplay={toolDisplay} onStopTask={onStopTask} />
            {errorText && (
                <ToolSection label="Error">
                    <p className="rounded bg-red-950/20 px-2 py-1.5 text-xs text-red-400">{errorText}</p>
                </ToolSection>
            )}
            {output !== undefined && (
                <ToolSection label="Output">
                    <ToolOutput output={output} />
                </ToolSection>
            )}
        </>
    )

    if (dense) {
        return (
            <StepRow iconProps={iconProps} label={label} detail={summary} status={status}>
                {details}
            </StepRow>
        )
    }

    return (
        <ToolCallRow
            label={label}
            summary={summary}
            icon={iconProps.icon}
            iconSrc={iconProps.src}
            status={status}
            open={open}
            onOpenChange={setOpen}
            elapsed={<ElapsedTime active={live} className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" />}
        >
            {details}
        </ToolCallRow>
    )
}
