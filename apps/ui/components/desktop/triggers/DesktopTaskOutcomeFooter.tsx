'use client'

import { Badge } from '@rerun/ui/primitives'
import { Button } from '@/components/ui/button'
import { shortRelativeTime } from '@/lib/time'
import type { DesktopTriggerOutcome } from '@/lib/desktop/triggers'

/**
 * Faithful TaskOutcomeFooter adapter for triggers.
 * Shows Done/Failed from real ended outcomes; Needs input / Running only when durable history says so.
 * Optional Open chat uses an adopted local session id — never invents a target.
 */
export function DesktopTaskOutcomeFooter({
    outcome,
    lastStartedAt,
    onOpenChat,
}: {
    outcome: DesktopTriggerOutcome | undefined
    lastStartedAt: string | null | undefined
    onOpenChat?: (localSessionId: string, runId: string | null) => void
}) {
    if (!outcome) {
        return lastStartedAt ? <>last run {shortRelativeTime(lastStartedAt)} ago</> : <>Never ran</>
    }

    if (outcome.status === 'running') {
        return (
            <span className="flex flex-wrap items-center gap-1.5">
                <Badge size="xs" tone="cyan" glow={false}>Running</Badge>
                {outcome.localSessionId && onOpenChat && (
                    <Button type="button" size="sm" variant="ghost" className="h-auto px-1 py-0 text-[11px]" onClick={() => onOpenChat(outcome.localSessionId!, outcome.runId)}>
                        Open chat
                    </Button>
                )}
            </span>
        )
    }

    if (outcome.status === 'needs-input') {
        return (
            <span className="flex flex-wrap items-center gap-1.5">
                <Badge size="xs" tone="orange" glow={false}>Needs input</Badge>
                {outcome.localSessionId && onOpenChat ? (
                    <Button type="button" size="sm" variant="ghost" className="h-auto px-1 py-0 text-[11px]" onClick={() => onOpenChat(outcome.localSessionId!, outcome.runId)}>
                        Open chat
                    </Button>
                ) : (
                    <span className="text-[11px] text-muted-foreground">Waiting in its chat</span>
                )}
            </span>
        )
    }

    const failed = outcome.status === 'error'
    return (
        <span className="flex flex-wrap items-center gap-1.5">
            <Badge size="xs" tone={failed ? 'red' : 'green'} glow={false}>
                {failed ? 'Failed' : 'Done'}
            </Badge>
            {outcome.finishedAt && <span className="tabular-nums">{shortRelativeTime(outcome.finishedAt)}</span>}
            {outcome.localSessionId && onOpenChat && (
                <Button type="button" size="sm" variant="ghost" className="h-auto px-1 py-0 text-[11px]" onClick={() => onOpenChat(outcome.localSessionId!, outcome.runId)}>
                    Open chat
                </Button>
            )}
        </span>
    )
}
