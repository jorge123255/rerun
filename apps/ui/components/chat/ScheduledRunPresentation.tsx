'use client'

import { ThreadDividerDialog } from '@/components/chat/ThreadDividerDialog'
import { ThreadDividerDot, ThreadDividerLine, ThreadDividerLink } from '@/components/chat/ThreadDividerLine'
import { CalendarClockIcon } from '@/lib/icons'
import type { ScheduledRun } from '@/lib/schedules/scheduled-run'
import { useState, type ReactNode } from 'react'

/** Shared Rerun presentation. The caller supplies its own workspace-aware prompt renderer. */
export function ScheduledRunPresentation({ run, children }: { run: ScheduledRun; children: ReactNode }) {
    const [promptOpen, setPromptOpen] = useState(false)
    return <>
        <ThreadDividerLine icon={<CalendarClockIcon className="size-3.5" />}>
            Scheduled run
            <ThreadDividerDot />
            <span className="min-w-0 truncate font-medium text-foreground">{run.name}</span>
            <ThreadDividerDot />
            <ThreadDividerLink onClick={() => setPromptOpen(true)}>View prompt</ThreadDividerLink>
        </ThreadDividerLine>
        <ThreadDividerDialog open={promptOpen} onOpenChange={setPromptOpen} icon={<CalendarClockIcon className="size-3.5 text-muted-foreground" />} title={`${run.name} prompt`}>
            {children}
        </ThreadDividerDialog>
    </>
}
