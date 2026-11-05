'use client'

import type { DesktopUploadItem } from '@/lib/desktop/composer-upload'
import { formatBytes } from '@/lib/files/format'
import { FileTextIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function statusLine(item: DesktopUploadItem): { text: string; tone: 'muted' | 'error' } {
    if (item.status === 'queued') return { text: 'Waiting', tone: 'muted' }
    if (item.status === 'importing') return { text: 'Importing…', tone: 'muted' }
    return { text: item.error ?? '', tone: 'error' }
}

/**
 * The Mac port of the original composer attachment chips for files picked on this computer: each
 * chip tracks its own import through the coworker's files route. A definitive refusal offers a
 * retry of the same name; an unreadable outcome stays unresolved with recovery through Files and
 * is never retried blindly.
 */
export function DesktopUploadChips({ items, disabled, onRemove, onRetry }: {
    items: readonly DesktopUploadItem[]
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
                className={cn('inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
                    failed || unresolved ? 'border-destructive/50' : 'border-border')}>
                {unresolved
                    ? <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
                    : <FileTextIcon aria-hidden className="size-3.5 shrink-0" />}
                <span className="sr-only">{unresolved ? 'Unresolved upload: ' : failed ? 'Failed upload: ' : 'Uploading file: '}</span>
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
