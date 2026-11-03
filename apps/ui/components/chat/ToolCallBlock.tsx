'use client'

import { ElapsedTime } from '@/components/chat/ElapsedTime'
import { hasDetails, ToolCallDetails, ToolStepRow, toolStatusOf, type ToolCallBlockProps } from './ToolStepRow'
import { useToolDisplay } from '@/hooks/useToolDisplay'
import { agentIdOf } from '@/lib/chat/tool-headline'
import { useBoardStore } from '@/stores/board.store'
import { ToolCallRow } from '@rerun/ui/chat'

export { ToolOutput, ToolSection, toolStatusOf, type ToolState } from './ToolStepRow'

export function ToolCallStep(props: ToolCallBlockProps) {
    const display = useToolDisplay(props.agentId)(props.toolName, props.input)
    const targetAgentId = agentIdOf(props.input)
    const targetAgentName = useBoardStore(s => s.agents.find(agent => agent.id === targetAgentId)?.name)
    return <ToolStepRow {...props} {...display} targetAgentName={targetAgentName} />
}

export function ToolCallBlock(props: ToolCallBlockProps) {
    const { label, iconProps } = useToolDisplay(props.agentId)(props.toolName, props.input)
    const running = toolStatusOf(props.state) === 'running'

    return (
        <ToolCallRow
            label={label}
            icon={iconProps.icon}
            iconSrc={iconProps.src}
            status={toolStatusOf(props.state)}
            elapsed={<ElapsedTime active={running} className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" />}
        >
            {hasDetails(props) && <ToolCallDetails {...props} />}
        </ToolCallRow>
    )
}
