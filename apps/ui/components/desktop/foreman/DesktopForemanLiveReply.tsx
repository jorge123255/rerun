'use client'

import type { ReactElement } from 'react'
import { StepGroup, type StepGroupItem } from '@/components/chat/StepGroup'
import { StepRow } from '@/components/chat/StepRow'
import type { DesktopForemanLiveReply as LiveReply } from '@/lib/desktop/foreman/live-reply'
import { getToolMeta } from '@/lib/tool-meta'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopForemanMarkdown } from './transcript/DesktopForemanHistoryMessage'

export function DesktopForemanLiveReply({ reply }: { reply: LiveReply }) {
    const { t } = useDesktopLocale()
    const groups = new Map<number, StepGroupItem[]>()
    for (const [index, step] of (reply.steps ?? []).entries()) {
        const { icon, label } = getToolMeta(step.tool)
        const iconProps = { icon }
        const items = groups.get(step.offset) ?? []
        items.push({
            key: String(index), iconProps, status: step.status,
            runningLabel: t('chatActivity.runningTool', { tool: label }),
            node: <StepRow iconProps={iconProps} label={label} status={step.status} />,
        })
        groups.set(step.offset, items)
    }
    const blocks: ReactElement[] = []
    let from = 0
    const appendText = (end: number) => {
        const text = reply.text.slice(from, end)
        if (text.trim()) blocks.push(<div key={`text-${from}`} className="max-w-[95%] rounded-lg px-4 py-3 text-sm text-foreground">
            <DesktopForemanMarkdown text={text} streaming />
        </div>)
    }
    for (const [offset, items] of groups) {
        appendText(offset)
        blocks.push(<div key={`steps-${offset}`} data-foreman-live-steps className="min-w-0 px-4"><StepGroup items={items} /></div>)
        from = offset
    }
    appendText(reply.text.length)
    return <div data-foreman-live-reply data-chat-find-ignore className="flex min-w-0 flex-col gap-2">{blocks}</div>
}
