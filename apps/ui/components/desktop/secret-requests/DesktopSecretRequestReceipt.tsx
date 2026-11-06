'use client'

import { Badge, PANEL_CARD } from '@rerun/ui/primitives'
import { KeyIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopSecretRequestView } from '@rerun/contracts'

export function DesktopSecretRequestReceipt({ request, className }: { request: DesktopSecretRequestView; className?: string }) {
    const receipt = request.receipt
    if (!receipt) return null
    return <DesktopSecretSummaryReceipt requestId={request.requestId} className={className} entries={request.fields.map(field => ({ ...field, provided: receipt.providedKeys.includes(field.key) }))} />
}

export function DesktopSecretSummaryReceipt({ entries, requestId, className }: { entries: { key: string; label?: string; provided: boolean }[]; requestId?: string; className?: string }) {
    return <div className={cn(PANEL_CARD, 'ml-auto w-full max-w-[85%] overflow-hidden', className)} data-secret-receipt={requestId}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
            <KeyIcon className="size-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">Keys</span>
            <span className="ml-auto text-muted-foreground">{entries.filter(field => field.provided).length} of {entries.length} stored</span>
        </div>
        <div className="divide-y divide-border">
            {entries.map(field => {
                const provided = field.provided
                return <div key={field.key} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                        {field.label && field.label !== field.key && <p className={cn('truncate text-sm', provided ? 'text-foreground' : 'text-muted-foreground')}>{field.label}</p>}
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{field.key}</p>
                    </div>
                    <Badge size="xs" tone={provided ? 'green' : 'neutral'} glow={false}>{provided ? 'Stored' : 'Skipped'}</Badge>
                </div>
            })}
        </div>
        <p className="px-3 py-2 text-[11px] text-muted-foreground">Stored encrypted for this coworker. The coworker only sees the names.</p>
    </div>
}
