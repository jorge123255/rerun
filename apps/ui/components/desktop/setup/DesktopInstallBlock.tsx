'use client'

import { useState } from 'react'
import type { Components } from 'streamdown'
import { MessageResponse } from '@/components/ai-elements/message'
import { ThreadDividerDialog } from '@/components/chat/ThreadDividerDialog'
import { ThreadDividerDot, ThreadDividerLine, ThreadDividerLink } from '@/components/chat/ThreadDividerLine'
import { Box3Icon, CheckCircle2Icon } from '@/lib/icons'

// AgentInstallBlock's original divider and guide dialog, with local owner props and the same
// restricted Markdown policy as DesktopScheduledRunBlock. No hosted board/store is imported.
const components: Components = {
    a: ({ href, children }) => {
        const url = href && URL.canParse(href) ? new URL(href) : null
        return url?.protocol === 'https:' && !url.username && !url.password
            ? <a data-streamdown="link" href={url.href} target="_blank" rel="noopener noreferrer">{children}</a>
            : <span>{children}</span>
    },
    img: ({ alt }) => <span>{alt || 'Image'}</span>,
}
const plugins = {}, rehypePlugins: [] = []

export function DesktopInstallBlock({ agentName, guide, installing = false }: { agentId?: string; agentName: string; guide: string; installing?: boolean }) {
    const [guideOpen, setGuideOpen] = useState(false)
    return <>
        <ThreadDividerLine flowing={installing} icon={installing ? <Box3Icon className="size-3.5" /> : <CheckCircle2Icon className="size-3.5 text-emerald-500" />}>
            {installing ? 'Install started' : 'Install complete'}
            <ThreadDividerDot />
            <ThreadDividerLink onClick={() => setGuideOpen(true)}>View guide</ThreadDividerLink>
        </ThreadDividerLine>
        <ThreadDividerDialog open={guideOpen} onOpenChange={setGuideOpen} icon={<Box3Icon className="size-3.5 text-muted-foreground" />} title={`${agentName} install guide`}>
            <MessageResponse components={components} plugins={plugins} rehypePlugins={rehypePlugins}
                controls={false} skipHtml mode="static" isAnimating={false} className="min-w-0 wrap-anywhere [&_pre]:overflow-x-auto">
                {guide}
            </MessageResponse>
        </ThreadDividerDialog>
    </>
}
