'use client'

import { ElapsedTime } from '@/components/chat/ElapsedTime'
import { StepRow } from '@/components/chat/StepRow'
import { SubRunTree } from '@/components/chat/SubRunTree'
import { ToolOutput, ToolSection, toolStatusOf, type ToolState } from '@/components/chat/ToolCallBlock'
import { useToolDisplay } from '@/hooks/useToolDisplay'
import { isSubRunLive, subRunHeadline, type SubRunProgress } from '@/lib/chat/sub-run-progress'
import { ToolCallRow, type ToolCallStatus } from '@rerun/ui/chat'
import { useEffect, useRef, useState } from 'react'

export function DesktopCoworkerSubRunBlock({ toolName, agentId, state, output, errorText, progress, onStopTask, dense = false, liveElapsed = false }: {
    toolName: string
    agentId?: string
    state: ToolState
    output?: unknown
    errorText?: string
    progress: SubRunProgress
    onStopTask?: (taskId: string) => void
    dense?: boolean
    liveElapsed?: boolean
}) {
    const toolDisplay = useToolDisplay(agentId)
    const { iconProps } = toolDisplay(toolName)
    const live = toolStatusOf(state) === 'running' && progress.tasks.some(isSubRunLive)
    const { label, summary } = subRunHeadline(progress, live, toolName)
    const single = toolName === 'build_team' && progress.tasks.length === 1
    const [open, setOpen] = useState(live && !single)
    const wasLive = useRef(live)

    useEffect(() => {
        if (wasLive.current && !live) setOpen(false)
        wasLive.current = live
    }, [live])

    const everyTaskFailed = progress.tasks.every(task => task.status === 'error')
    const status: ToolCallStatus = live ? 'running' : everyTaskFailed ? 'error' : toolStatusOf(state) === 'error' ? 'error' : 'done'
    const details = (
        <>
            <SubRunTree tasks={progress.tasks} toolDisplay={toolDisplay} onStopTask={onStopTask} />
            {errorText && <ToolSection label="Error"><p className="rounded bg-red-950/20 px-2 py-1.5 text-xs text-red-400">{errorText}</p></ToolSection>}
            {output !== undefined && <ToolSection label="Output"><ToolOutput output={output} /></ToolSection>}
        </>
    )

    if (dense) return <StepRow iconProps={iconProps} label={label} detail={summary} status={status}>{details}</StepRow>

    return (
        <ToolCallRow
            label={label}
            summary={summary}
            icon={iconProps.icon}
            iconSrc={iconProps.src}
            status={status}
            open={open}
            onOpenChange={setOpen}
            elapsed={liveElapsed && live ? <ElapsedTime active className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" /> : undefined}
        >
            {details}
        </ToolCallRow>
    )
}
