'use client'

import { Badge, Icon, PANEL_CARD } from '@rerun/ui/primitives'
import { BellIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { historicalIdentityProps } from './identity'
import { redactHistoricalText } from './redact'
import type { DesktopHistoricalIdentity } from './status'

/** Read-only copy of the delivered notification. Rendering it does not send another one. */
export function DesktopHistoricalNotification({ message, identity, toolCallId }: {
    message: string
    identity: DesktopHistoricalIdentity
    toolCallId: string
}) {
    const shown = redactHistoricalText(message)
    return (
        <div className={cn(PANEL_CARD, 'flex items-start gap-3 px-3 py-2.5')} data-historical="notification" data-status="succeeded" {...historicalIdentityProps(identity, toolCallId)}>
            <Icon icon={BellIcon} size="sm" />
            <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Sent you a notification</p>
                <p className="mt-0.5 text-sm whitespace-pre-wrap text-foreground">{shown}</p>
            </div>
            <Badge size="xs" tone="neutral" glow={false} className="mt-0.5">Read</Badge>
        </div>
    )
}
