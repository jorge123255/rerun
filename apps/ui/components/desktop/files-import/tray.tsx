'use client'

import { Progress } from '@/components/ui/progress'
import { CheckIcon, ChevronDownIcon, RefreshCwIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useId, useState } from 'react'
import { filesImportSettlement, filesImportTotalProgress } from './queue'
import type { FilesImportItem } from './types'

type FilesImportTrayProps = {
    items: FilesImportItem[]
    onCancel: (id: string) => void
    onRetry: (id: string) => void
    onDismiss: () => void
}

const COLLAPSED_ROWS = 6

function statusLine(item: FilesImportItem): string {
    if (item.saved) return 'Imported'
    if (item.status === 'error') return item.error ?? 'Import failed'
    if (item.status === 'finishing') return 'Finishing'
    if (item.status === 'queued') return 'Waiting'
    return `${Math.round(item.progress * 100)}%`
}

function rank(item: FilesImportItem): number {
    if (item.status === 'error') return 0
    if (item.status === 'uploading' || item.status === 'finishing') return 1
    if (item.status === 'queued') return 2
    return 3
}

export function FilesImportTray({ items, onCancel, onRetry, onDismiss }: FilesImportTrayProps) {
    const [expanded, setExpanded] = useState(false)
    const [open, setOpen] = useState<boolean | null>(null)
    const listId = useId()
    if (items.length === 0) return null

    const settled = filesImportSettlement(items)
    const failed = items.filter(item => item.saved !== true && (item.status === 'error' || item.status === 'done')).length
    const isOpen = open ?? !(settled != null && failed === 0)
    const ordered = [...items].sort((left, right) => rank(left) - rank(right))
    const visible = expanded ? ordered : ordered.slice(0, COLLAPSED_ROWS)
    const hidden = ordered.length - visible.length
    const heading = settled ?? `Importing ${items.filter(item => item.saved).length + 1} of ${items.length}`

    return (
        <div className="absolute inset-x-0 bottom-0 z-20 border-t border-border bg-background/95" data-testid="files-import-tray">
            <div className="flex items-center gap-2 px-3 py-2">
                <button type="button" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} aria-controls={listId} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <ChevronDownIcon className={cn('size-3.5 shrink-0 text-muted-foreground', !isOpen && '-rotate-90')} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{heading}</span>
                </button>
                <button type="button" onClick={onDismiss} className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground">
                    {settled == null ? 'Cancel all' : 'Dismiss'}
                </button>
            </div>
            {settled == null && (
                <div className="px-3 pb-2">
                    <Progress value={filesImportTotalProgress(items) * 100} size="md" label="Total import progress" />
                </div>
            )}
            {isOpen && (
                <div id={listId} className="max-h-56 overflow-y-auto border-t border-border/60">
                    {visible.map(item => (
                        <div key={item.id} className="flex items-center gap-2 px-3 py-1.5" data-testid="files-import-row" data-saved={item.saved ? 'true' : 'false'} data-status={item.status}>
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <div className="flex items-baseline gap-1.5">
                                    <span className="truncate text-xs text-foreground">{item.name}</span>
                                    {item.dir && <span className="shrink-0 truncate text-[10px] text-muted-foreground">{item.dir}</span>}
                                </div>
                                {item.saved ? <span className="text-[10px] text-muted-foreground">{statusLine(item)}</span> : (
                                    <>
                                        <Progress value={item.status === 'finishing' ? null : item.progress * 100} size="sm" tone={item.status === 'error' ? 'destructive' : 'brand'} label={`Importing ${item.name}`} />
                                        <span className={item.status === 'error' ? 'text-[10px] text-destructive' : 'text-[10px] text-muted-foreground'}>{statusLine(item)}</span>
                                    </>
                                )}
                            </div>
                            {item.saved ? <CheckIcon className="size-3.5 text-muted-foreground" /> : item.status === 'error' ? (
                                <button type="button" onClick={() => onRetry(item.id)} title="Retry" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                                    <RefreshCwIcon className="size-3.5" />
                                </button>
                            ) : (
                                <button type="button" onClick={() => onCancel(item.id)} title="Cancel" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                                    <XIcon className="size-3.5" />
                                </button>
                            )}
                        </div>
                    ))}
                    {hidden > 0 && (
                        <button type="button" onClick={() => setExpanded(true)} className="w-full px-3 py-1.5 text-left text-[10px] text-muted-foreground hover:text-foreground">
                            + {hidden} more
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
