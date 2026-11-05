'use client'

import { MessageResponse } from '@/components/ai-elements/message'
import { ScheduledRunPresentation } from '@/components/chat/ScheduledRunPresentation'
import type { ScheduledRun } from '@/lib/schedules/scheduled-run'
import type { Components } from 'streamdown'

// Same local Markdown policy as desktop replies: no remote images, raw HTML or hosted
// workspace navigation. HTTPS links remain subject to the Electron shell's external policy.
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

export function DesktopScheduledRunBlock({ run }: { run: ScheduledRun }) {
    return <ScheduledRunPresentation run={run}>
        <MessageResponse components={components} plugins={plugins} rehypePlugins={rehypePlugins}
            controls={false} skipHtml mode="static" isAnimating={false} className="min-w-0 wrap-anywhere [&_pre]:overflow-x-auto">
            {run.prompt}
        </MessageResponse>
    </ScheduledRunPresentation>
}
