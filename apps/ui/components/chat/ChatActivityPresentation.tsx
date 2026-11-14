'use client'

import type { ReactNode } from 'react'
import { TextShimmer } from '@rerun/ui'

import { Message, MessageContent } from '@/components/ai-elements/message'
import { DotSpinner } from '@/components/ui/dot-spinner'
import { TextLoop } from '@/components/ui/text-loop'

export function ChatActivityPresentation({ activity, labels, indicator, announce = false }: {
    activity: string | null
    labels: readonly string[]
    indicator?: ReactNode
    announce?: boolean
}) {
    return (
        <Message from="assistant" data-chat-find-ignore>
            <MessageContent className="overflow-visible">
                {announce && <span role="status" className="sr-only">{activity ?? labels[0]}</span>}
                <div className="flex items-center gap-2 py-1" aria-hidden={announce || undefined}>
                    {indicator ?? <DotSpinner variant="light" size="xs" />}
                    {activity ? (
                        <TextShimmer className="text-sm">{activity}</TextShimmer>
                    ) : (
                        <TextLoop className="text-sm" interval={2.5}>
                            {labels.map(label => <TextShimmer key={label}>{label}</TextShimmer>)}
                        </TextLoop>
                    )}
                </div>
            </MessageContent>
        </Message>
    )
}
