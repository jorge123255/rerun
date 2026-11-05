'use client'

import type { DesktopWebSearchOutcome } from '@rerun/contracts'
import { desktopWebSearchResultView } from '@/lib/desktop/web-search'

export function DesktopWebSearchResults({ outcome }: { outcome: DesktopWebSearchOutcome }) {
    const view = desktopWebSearchResultView(outcome)
    if (view.kind === 'empty') return <p className="text-xs text-muted-foreground">{view.message}</p>
    if (view.kind === 'error') return <p role="alert" className="break-words text-xs text-destructive">{view.message}</p>

    return (
        <div className="min-w-0 space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Search results · {view.provenance.provider}</p>
            <ol className="min-w-0 space-y-3">
                {view.results.map((result, index) => (
                    <li key={`${index}:${result.url}`} className="flex min-w-0 items-start gap-2 text-xs">
                        <span className="shrink-0 font-mono text-muted-foreground">{index + 1}.</span>
                        <div className="min-w-0 space-y-0.5">
                            <a href={result.url} target="_blank" rel="noreferrer" className="inline-block max-w-full break-words font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground">
                                {result.title}
                            </a>
                            <p className="break-all text-muted-foreground">{result.url}</p>
                            {result.snippet && <p className="whitespace-pre-wrap break-words text-foreground/80">{result.snippet}</p>}
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    )
}
