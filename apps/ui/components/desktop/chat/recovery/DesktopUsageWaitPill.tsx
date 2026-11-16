'use client'

import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { ClockIcon } from '@/lib/icons'
import type { DesktopUsageWaitView } from '@/lib/desktop/server/usage-waits'
import { usageResetLine } from './DesktopProviderErrorNotice'

/**
 * The one message this conversation is keeping until its plan resets: what it says, when it goes,
 * and a way to cancel it. A message that was held back instead of sent says why.
 */
export function DesktopUsageWaitPill({ wait, busy, onCancel }: { wait: DesktopUsageWaitView; busy?: boolean; onCancel: () => void }) {
    const held = wait.state === 'held'
    const preview = wait.text.length > 160 ? `${wait.text.slice(0, 160)}…` : wait.text
    return <div role="status" data-usage-wait={wait.state} className="mb-2 flex items-start gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <Icon icon={ClockIcon} size="sm" />
        <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-medium">{held ? 'Message not sent' : wait.state === 'sending' ? 'Sending your message…' : 'Waiting to send your message'}</p>
            <p className="text-muted-foreground">{held ? wait.reason ?? 'The message was held back.' : usageResetLine({ name: wait.plan, resetsAt: wait.resetsAt })}</p>
            <p className="truncate text-xs text-muted-foreground">“{preview}”</p>
        </div>
        {wait.state !== 'sending' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>{held ? 'Dismiss' : 'Cancel'}</Button>}
    </div>
}
