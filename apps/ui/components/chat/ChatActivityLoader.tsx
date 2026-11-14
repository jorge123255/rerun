'use client'

import type { ReactNode } from 'react'
import { ChatActivityPresentation } from './ChatActivityPresentation'
import { useToolDisplay } from '@/hooks/useToolDisplay'
import { liveActivityLabel, loadingLabels } from '@/lib/agent-chat-loader'

type ChatActivityLoaderProps = {
    agentId?: string
    message?: Parameters<typeof liveActivityLabel>[0]
    /** Ce qui tourne à gauche du label. Le Foreman y met sa bête, un agent garde les points. */
    indicator?: ReactNode
}

export function ChatActivityLoader({ agentId, message, indicator }: ChatActivityLoaderProps) {
    const toolDisplay = useToolDisplay(agentId)
    const activity = liveActivityLabel(message, (toolName, input) => toolDisplay(toolName, input).label)

    return <ChatActivityPresentation activity={activity} labels={loadingLabels} indicator={indicator} />
}
