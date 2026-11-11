'use client'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { RefreshCcwIcon, XIcon } from '@/lib/icons'
import { formatBytes } from '@/lib/files/format'
import { desktopDocumentReadUrl } from '@/lib/desktop/document-attachments/client'
import { cn } from '@/lib/utils'
import type { DesktopDocumentAttachment } from '@rerun/contracts'

const STATUS: Record<DesktopDocumentAttachment['conversion']['state'], string> = {
    pending: 'Waiting',
    converting: 'Preparing',
    ready: 'Ready',
    failed: 'Failed',
    unsupported: 'Not supported by this model',
}

export function DesktopDocumentChips({ attachments, onRetry, onRemove, disabled = false }: {
    attachments: DesktopDocumentAttachment[]
    onRetry: (attachmentId: string) => void
    onRemove: (attachmentId: string) => void
    disabled?: boolean
}) {
    if (!attachments.length) return null
    return <div className="flex max-w-full flex-wrap gap-1.5 px-2 pt-2">
        {attachments.map(attachment => {
            const state = attachment.conversion.state
            const busy = state === 'converting' || !attachment.uploaded && state === 'pending'
            return <div key={attachment.attachmentId} className={cn('flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs', state === 'failed' ? 'border-destructive/40 text-destructive' : state === 'unsupported' ? 'border-amber-500/40 text-amber-600' : 'border-border/60 text-muted-foreground')}>
                {busy ? <Spinner className="size-3" /> : null}
                {attachment.kind === 'image' && attachment.uploaded && <img src={desktopDocumentReadUrl(attachment, 'preview')} alt="" className="size-8 shrink-0 rounded object-cover" />}
                <span className="max-w-48 truncate font-medium text-foreground" title={attachment.name}>{attachment.name}</span>
                <span className="shrink-0 text-[10px]">{formatBytes(attachment.byteLength)} · {busy && !attachment.uploaded ? 'Saving' : STATUS[state]}</span>
                {(!busy && state !== 'ready' && state !== 'unsupported') && <Button type="button" disabled={disabled} variant="ghost" size="sm" aria-label={`${attachment.kind === 'audio' && attachment.uploaded ? 'Transcribe' : attachment.uploaded ? 'Prepare' : 'Retry'} ${attachment.name}`} onClick={() => onRetry(attachment.attachmentId)}><RefreshCcwIcon className="size-3" />{attachment.kind === 'audio' && attachment.uploaded ? 'Transcribe' : attachment.uploaded ? 'Prepare' : 'Retry'}</Button>}
                <Button type="button" disabled={disabled || busy} variant="ghost" size="icon-xs" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.attachmentId)}><XIcon className="size-3" /></Button>
            </div>
        })}
    </div>
}
