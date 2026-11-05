'use client'

import { ImageIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from '@/lib/icons'
import { formatBytes } from '@/lib/files/format'
import type { DesktopImageUploadItem } from '@/lib/desktop/composer-image'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function statusLine(item: DesktopImageUploadItem): { text: string; tone: 'muted' | 'error' } {
    if (item.status === 'queued') return { text: 'Waiting', tone: 'muted' }
    if (item.status === 'importing') return { text: 'Importing…', tone: 'muted' }
    return { text: item.error ?? '', tone: 'error' }
}

/**
 * The Mac port of the original composer image chips: each chip carries the picked file's own
 * thumbnail while its import runs through the coworker's images route. A definitive refusal
 * offers a retry of the same file; an unreadable outcome stays unresolved with recovery through
 * Files and is never retried blindly.
 */
export function DesktopImageUploadChips({ items, disabled, onRemove, onRetry }: {
    items: readonly DesktopImageUploadItem[]
    disabled?: boolean
    onRemove: (id: string) => void
    onRetry: (id: string) => void
}) {
    if (!items.length) return null
    return <div className="flex flex-wrap items-center gap-1">
        {items.map(item => {
            const unresolved = item.status === 'unresolved'
            const failed = item.status === 'error'
            const status = statusLine(item)
            return <span key={item.id} title={item.name}
                className={cn('inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-xs',
                    failed || unresolved ? 'border-destructive/50' : 'border-border')}>
                {item.previewUrl
                    ? <img src={item.previewUrl} alt="" className="size-8 shrink-0 rounded object-cover" />
                    : unresolved
                        ? <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
                        : <ImageIcon aria-hidden className="size-3.5 shrink-0" />}
                <span className="sr-only">{unresolved ? 'Unresolved upload: ' : failed ? 'Failed upload: ' : 'Uploading image: '}</span>
                <span className="flex min-w-0 flex-col">
                    <span className="max-w-40 truncate">{item.name}</span>
                    <span className={cn('max-w-40 truncate text-[10px]', status.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                        {status.tone === 'muted' ? `${status.text} · ${formatBytes(item.size)}` : status.text}
                    </span>
                </span>
                {failed && <Button type="button" size="icon-sm" variant="ghost" disabled={disabled}
                    aria-label={`Retry import ${item.name}`} title="Retry import"
                    onClick={() => onRetry(item.id)}><RefreshCwIcon className="size-3" /></Button>}
                <Button type="button" size="icon-sm" variant="ghost" disabled={disabled}
                    aria-label={`Remove upload ${item.name}`}
                    title={item.status === 'importing' ? 'Cancel import' : 'Remove attachment'}
                    onClick={() => onRemove(item.id)}><XIcon className="size-3" /></Button>
            </span>
        })}
    </div>
}
