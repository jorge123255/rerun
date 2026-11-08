'use client'

import { Button, Icon } from '@rerun/ui/primitives'
import { BrainIcon } from '@/lib/icons'
import { historicalIdentityProps } from './identity'
import type { BrainChangeStatus } from '@rerun/contracts'
import type { DesktopHistoricalIdentity } from './status'

/**
 * Read-only brain change. Undo and the hosted refresh-on-mount are omitted.
 * Open renders only when the caller passes onOpen; the default does not navigate.
 */
export function DesktopHistoricalBrainChange({ headline, note, brainStatus, identity, toolCallId, onOpen }: {
    headline: string
    note: string
    brainStatus: BrainChangeStatus
    identity: DesktopHistoricalIdentity
    toolCallId: string
    onOpen?: () => void
}) {
    const open = brainStatus !== 'deleted' && onOpen
    return (
        <div className="rounded-xl bg-muted/30 px-1.5 py-1.5" data-historical="brain-change" data-status="succeeded" data-brain-status={brainStatus} {...historicalIdentityProps(identity, toolCallId)}>
            <div className="flex items-center gap-3 text-sm">
                <Icon size="sm" icon={BrainIcon} />
                <div className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{headline}</span>
                    <span className="block truncate text-xs text-muted-foreground">{note}</span>
                </div>
                {open && <Button type="button" size="xs" variant="ghost" onClick={onOpen}>Open</Button>}
            </div>
        </div>
    )
}
