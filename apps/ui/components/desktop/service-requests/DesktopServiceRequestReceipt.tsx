'use client'

import { Badge, PANEL_CARD, type BadgeTone } from '@rerun/ui/primitives'
import { Icon } from '@/components/ui/icon'
import type { ServiceSetupEntry, ServiceSetupOutcome } from '@/lib/chat-hitl'
import { LinkIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

export type DesktopServiceRequestReceiptProps = {
    entries: readonly ServiceSetupEntry[]
}

const statuses: Record<ServiceSetupOutcome, { label: string; tone: BadgeTone }> = {
    connected: { label: 'Connected', tone: 'green' },
    skipped: { label: 'Skipped', tone: 'neutral' },
    reset: { label: 'Not reconnected', tone: 'orange' },
    'not-found': { label: 'Not found', tone: 'red' },
}

export function DesktopServiceRequestReceipt({ entries }: DesktopServiceRequestReceiptProps) {
    const connected = entries.filter(entry => entry.outcome === 'connected').length
    return <div className={cn(PANEL_CARD, 'ml-auto w-full min-w-0 max-w-[85%] overflow-hidden')}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
            <LinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">Apps</span>
            <span className="ml-auto text-muted-foreground">{connected} of {entries.length} connected</span>
        </div>
        <div className="divide-y divide-border">{entries.map((entry, index) => {
            const status = statuses[entry.outcome]
            const dimmed = entry.outcome !== 'connected'
            return <div key={index} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <Icon icon={LinkIcon} size="sm" className={cn(dimmed && 'opacity-50')} />
                <div className="min-w-0 flex-1 basis-24">
                    <p className={cn('wrap-anywhere text-sm', dimmed ? 'text-muted-foreground' : 'text-foreground')}>{entry.name}</p>
                    {entry.replaces && <p className="wrap-anywhere text-xs text-muted-foreground">Instead of {entry.replaces}</p>}
                </div>
                <Badge size="xs" tone={status.tone} glow={false}>{status.label}</Badge>
            </div>
        })}</div>
    </div>
}
