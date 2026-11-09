'use client'

import type { DesktopSharedImportResult } from '@/lib/desktop/shared-workspace-files'
import { Button } from '@/components/ui/button'
import { RefreshCwIcon, TriangleAlertIcon } from '@/lib/icons'

export function DesktopSharedImportResults({ results, disabled, onRetry, onOpen }: {
    results: readonly DesktopSharedImportResult[]
    disabled?: boolean
    onRetry: (result: DesktopSharedImportResult) => void
    onOpen: (path: string) => void
}) {
    if (!results.length) return null
    return <ul aria-label="Import results" className="flex max-h-56 flex-col gap-1 overflow-y-auto border-y px-4 py-3 text-xs">
        {results.map((result, index) => {
            const label = [result.folder, result.name].filter(Boolean).join('/')
            return <li key={`${label}:${index}`} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-2 py-1.5">
                {result.status === 'uncertain' && <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />}
                <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
                <span className={result.status === 'created' ? 'text-muted-foreground' : 'text-destructive'}>{result.status}</span>
                {result.path && <Button type="button" size="xs" variant="ghost" onClick={() => onOpen(result.path!)}>Open</Button>}
                {result.status === 'refused' && <Button type="button" size="icon-xs" variant="ghost" disabled={disabled}
                    aria-label={`Retry import ${label}`} title="Retry import" onClick={() => onRetry(result)}><RefreshCwIcon className="size-3" /></Button>}
                {result.message && <span className="w-full text-muted-foreground">{result.message}</span>}
            </li>
        })}
    </ul>
}
