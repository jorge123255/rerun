'use client'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { RefreshCcwIcon, XIcon } from '@/lib/icons'
import { formatBytes } from '@/lib/files/format'
import { cn } from '@/lib/utils'
import type { DesktopDocumentAttachment } from '../../../../../packages/contracts/src/desktop-document-attachments.ts'

const STATUS: Record<DesktopDocumentAttachment['conversion']['state'], string> = {
    pending: 'Waiting',
    converting: 'Preparing',
    ready: 'Ready',
    failed: 'Failed',
    unsupported: 'Not supported by this model',
}

export function DesktopDocumentChips({ attachments, onRetry, onRemove }: {
    attachments: DesktopDocumentAttachment[]
    onRetry: (attachmentId: string) => void
    onRemove: (attachmentId: string) => void
}) {
    if (!attachments.length) return null
    return <div className="flex max-w-full flex-wrap gap-1.5 px-2 pt-2">
        {attachments.map(attachment => {
            const state = attachment.conversion.state
            const busy = state === 'pending' || state === 'converting'
            return <div key={attachment.attachmentId} className={cn('flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs', state === 'failed' ? 'border-destructive/40 text-destructive' : state === 'unsupported' ? 'border-amber-500/40 text-amber-600' : 'border-border/60 text-muted-foreground')}>
                {busy ? <Spinner className="size-3" /> : null}
                <span className="max-w-48 truncate font-medium text-foreground" title={attachment.name}>{attachment.name}</span>
                <span className="shrink-0 text-[10px]">{formatBytes(attachment.byteLength)} · {STATUS[state]}</span>
                {(state === 'failed' || state === 'unsupported') && <Button type="button" variant="ghost" size="icon-xs" aria-label={`Retry ${attachment.name}`} onClick={() => onRetry(attachment.attachmentId)}><RefreshCcwIcon className="size-3" /></Button>}
                {!attachment.admitted && <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.attachmentId)}><XIcon className="size-3" /></Button>}
            </div>
        })}
    </div>
}
