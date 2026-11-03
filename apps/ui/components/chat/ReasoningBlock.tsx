'use client'

import { MessageResponse } from '@/components/ai-elements/message'
import { StepRow } from '@/components/chat/StepRow'
import { BrainIcon } from '@/lib/icons'
import type { ReactNode } from 'react'

const renderMarkdown = (text: string) => <MessageResponse>{text}</MessageResponse>

/** A settled or running thought on one line of the folded steps. */
export function ReasoningStep({ text, isStreaming = false, renderText = renderMarkdown }: {
    text: string; isStreaming?: boolean; renderText?: (text: string) => ReactNode
}) {
    return (
        <StepRow iconProps={{ icon: BrainIcon }} label={isStreaming ? 'Thinking...' : 'Thought'} detail={text.replace(/\s+/g, ' ')} status={isStreaming ? 'running' : 'done'}>
            {text && <div className="border-l border-border pl-3 text-xs leading-relaxed text-muted-foreground/80">{renderText(text)}</div>}
        </StepRow>
    )
}
