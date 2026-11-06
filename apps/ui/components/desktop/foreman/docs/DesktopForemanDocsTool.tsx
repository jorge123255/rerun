'use client'

import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { desktopForemanDocsResultSchema, type DesktopForemanDocsResult as DocsResult } from '@rerun/contracts'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { DesktopToolStep } from '@/components/desktop/DesktopToolStep'

export function desktopForemanDocsOutput(output: unknown): DocsResult | null {
    let value = output
    if (typeof value === 'string') {
        try { value = JSON.parse(value) } catch { return null }
    }
    const parsed = desktopForemanDocsResultSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}

export function DesktopForemanDocsResult({ result }: { result: DocsResult }) {
    const entries: { title: string; url: string; text?: string }[] = result.passages.length
        ? result.passages
        : result.pages?.length
            ? result.pages
            : [{ title: 'Rerun documentation', url: result.documentation }]
    return (
        <div className="min-w-0 max-w-full text-xs text-muted-foreground">
            {result.note && <p className="mb-2 whitespace-pre-wrap break-words" role={result.status === 'unavailable' || result.status === 'cancelled' ? 'status' : undefined}>{result.note}</p>}
            <Sources className="mb-0 min-w-0">
                <SourcesTrigger count={entries.length} />
                <SourcesContent className="w-full max-w-full min-w-0">
                    {entries.map(entry => (
                        <div key={entry.url} className="min-w-0 max-w-full">
                            <Source href={entry.url} title={entry.title} rel="noopener noreferrer" className="min-w-0 max-w-full break-words" />
                            {'text' in entry && entry.text && <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words pl-6 text-foreground/80">{entry.text}</p>}
                        </div>
                    ))}
                    {result.source && (
                        <p className="break-words pl-6 text-[11px]">
                            Public documentation · {result.source.cacheState} cache · fetched {result.source.fetchedAt} · version {result.source.version}
                        </p>
                    )}
                </SourcesContent>
            </Sources>
        </div>
    )
}

export function DesktopForemanDocsTool({ part, restored }: { part: ToolUIPart | DynamicToolUIPart; restored: boolean }) {
    const result = part.state === 'output-available' ? desktopForemanDocsOutput(part.output) : null
    if (!result) return <DesktopToolStep part={part} restored={restored} />
    const call = { ...part, output: undefined } as typeof part
    return (
        <div className="min-w-0 max-w-full">
            <DesktopToolStep part={call} restored={restored} />
            <DesktopForemanDocsResult result={result} />
        </div>
    )
}
