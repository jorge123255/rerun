'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { RefreshCcwIcon, XIcon } from '@/lib/icons'
import { formatBytes } from '@/lib/files/format'
import { desktopDocumentReadUrl } from '@/lib/desktop/document-attachments/client'
import { cn } from '@/lib/utils'
import { isDesktopLargeStagedDocument, type DesktopDocumentAttachment } from '@rerun/contracts'
import { DesktopDocumentLightbox } from './DesktopDocumentLightbox'

const STATUS: Record<DesktopDocumentAttachment['conversion']['state'], string> = {
    pending: 'Waiting',
    converting: 'Preparing',
    ready: 'Ready',
    failed: 'Failed',
    unsupported: 'Not supported by this model',
}

/** A file the Mac cannot convert is ready once it is saved in the coworker's Files. */
export function desktopDocumentChipStatus(conversion: DesktopDocumentAttachment['conversion']): string {
    return conversion.mode === 'staged-file' && conversion.state === 'ready' ? 'Ready · saved to Files' : STATUS[conversion.state]
}

/** While a large file is being sent the chip says how far it is; a small one is saved in one step. */
export function desktopDocumentSavingStatus(sent: number | undefined): string {
    return sent === undefined ? 'Saving' : `Uploading ${Math.min(100, Math.max(0, Math.round(sent * 100)))}%`
}

export function DesktopDocumentChips({ attachments, onRetry, onRemove, progress, disabled = false }: {
    attachments: DesktopDocumentAttachment[]
    onRetry: (attachmentId: string) => void
    onRemove: (attachmentId: string) => void
    /** The sent share (0 to 1) of each large file that is uploading now, by attachment id. */
    progress?: Readonly<Record<string, number>>
    disabled?: boolean
}) {
    const [previewId, setPreviewId] = useState<string | null>(null)
    const previewTrigger = useRef<HTMLButtonElement>(null)
    // A large file is kept only in the coworker's Files, so it has no preview or download here.
    const uploaded = attachments.filter(file => file.uploaded && !isDesktopLargeStagedDocument(file))
    const previewIndex = uploaded.findIndex(file => file.attachmentId === previewId)
    if (previewId && (disabled || previewIndex < 0)) setPreviewId(null)
    if (!attachments.length) return null
    return <div className="flex max-w-full flex-wrap gap-1.5 px-2 pt-2">
        {attachments.map(attachment => {
            const state = attachment.conversion.state
            const busy = state === 'converting' || !attachment.uploaded && state === 'pending'
            const sent = busy && !attachment.uploaded ? progress?.[attachment.attachmentId] : undefined
            const previewable = attachment.uploaded && !isDesktopLargeStagedDocument(attachment)
            return <div key={attachment.attachmentId} className={cn('relative flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 text-xs', state === 'failed' ? 'border-destructive/40 text-destructive' : state === 'unsupported' ? 'border-amber-500/40 text-amber-600' : 'border-border/60 text-muted-foreground')}>
                {busy ? <Spinner className="size-3" /> : null}
                {attachment.kind === 'image' && attachment.uploaded && <img src={desktopDocumentReadUrl(attachment, 'preview')} alt="" className="size-8 shrink-0 rounded object-cover" />}
                {previewable
                    ? <button type="button" disabled={disabled} aria-label={`Preview ${attachment.name}`} title={attachment.name}
                        className="min-w-0 max-w-48 truncate rounded-sm font-medium text-foreground hover:underline focus-visible:outline-ring disabled:opacity-50"
                        onClick={event => { previewTrigger.current = event.currentTarget; setPreviewId(attachment.attachmentId) }}>
                        {attachment.name}
                    </button>
                    : <span className="max-w-48 truncate font-medium text-foreground" title={attachment.name}>{attachment.name}</span>}
                <span className="shrink-0 text-[10px]">{formatBytes(attachment.byteLength)} · {busy && !attachment.uploaded ? desktopDocumentSavingStatus(sent) : desktopDocumentChipStatus(attachment.conversion)}</span>
                {sent !== undefined && <span role="progressbar" aria-label={`Uploading ${attachment.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sent * 100)}
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-border/60"><span className="block h-full bg-primary transition-[width]" style={{ width: `${Math.round(sent * 100)}%` }} /></span>}
                {(!busy && state !== 'ready' && state !== 'unsupported') && <Button type="button" disabled={disabled} variant="ghost" size="sm" aria-label={`${attachment.kind === 'audio' && attachment.uploaded ? 'Transcribe' : attachment.uploaded ? 'Prepare' : 'Retry'} ${attachment.name}`} onClick={() => onRetry(attachment.attachmentId)}><RefreshCcwIcon className="size-3" />{attachment.kind === 'audio' && attachment.uploaded ? 'Transcribe' : attachment.uploaded ? 'Prepare' : 'Retry'}</Button>}
                <Button type="button" disabled={disabled || busy} variant="ghost" size="icon-xs" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.attachmentId)}><XIcon className="size-3" /></Button>
            </div>
        })}
        {!disabled && previewIndex >= 0 && <DesktopDocumentLightbox attachments={uploaded} index={previewIndex}
            onIndexChange={index => setPreviewId(uploaded[index].attachmentId)}
            onClose={() => setPreviewId(null)} returnFocus={() => previewTrigger.current?.focus()} />}
    </div>
}
