'use client'

import { useId, useState } from 'react'
import { RefreshCcwIcon, ZapIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

const LABELS: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
export const desktopEffortLabel = (effort: string) => LABELS[effort] ?? effort

export async function saveDesktopModelEffort(connectionId: string, model: string, effort: string | null) {
    const response = await fetch('/api/desktop/model-effort', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId, model, effort }) })
    const body = await response.json().catch(() => null) as { efforts?: Record<string, string>; error?: string } | null
    if (!response.ok || !body?.efforts) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not save this model’s reasoning effort.')
    return body.efforts
}

/**
 * The effort of the model in use, as a slider with one stop per level. The choice belongs to the
 * model: it applies wherever that model answers, for a coworker and for the Chief of Staff. The
 * reset button leaves the model its own effort again.
 */
export function DesktopModelEffort({ model, options, chosen, inherited, disabled, onChoose }: {
    model: string
    options: readonly string[]
    /** The effort picked for this model, if any. */
    chosen?: string
    /** What the model uses while nothing is picked, when that is known. */
    inherited?: string
    disabled?: boolean
    onChoose(effort: string | null): void
}) {
    const labelId = useId()
    const last = Math.max(options.length - 1, 1)
    const savedIndex = chosen ? options.indexOf(chosen) : -1
    const restingIndex = savedIndex >= 0 ? savedIndex : inherited && options.includes(inherited) ? options.indexOf(inherited) : Math.floor((options.length - 1) / 2)
    // The stop under the thumb while it is dragged; the saved one otherwise.
    const [dragged, setDragged] = useState<number | null>(null)
    const index = dragged ?? restingIndex
    const picked = dragged !== null || savedIndex >= 0
    const commit = () => {
        if (dragged === null) return
        const next = options[dragged]
        setDragged(null)
        if (next && next !== chosen) onChoose(next)
    }
    // The fill ends under the thumb's centre; the thumb stays inside the track at both ends.
    const at = `calc(1.125rem + (100% - 2.25rem) * ${index / last})`
    return <div role="group" aria-labelledby={labelId} data-testid="desktop-model-effort" data-effort={chosen ?? ''} className="rounded-xl border border-border bg-muted/30 px-3 pb-3 pt-2.5">
        <div className="flex items-start justify-between gap-2">
            <ZapIcon aria-hidden className="mt-1 size-4 text-muted-foreground" />
            <div className="min-w-0 text-center">
                <p id={labelId} className={cn('truncate text-sm font-semibold', picked ? 'text-primary' : 'text-muted-foreground')}>
                    {picked ? desktopEffortLabel(options[index] ?? '') : inherited ? `Default · ${desktopEffortLabel(inherited)}` : 'Default effort'}
                </p>
                <p className="truncate text-xs text-muted-foreground">{model}</p>
            </div>
            <button type="button" aria-label="Use this model’s default effort" title="Use this model’s default effort" disabled={disabled || !chosen}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40" onClick={() => { setDragged(null); onChoose(null) }}>
                <RefreshCcwIcon aria-hidden className="size-4" />
            </button>
        </div>
        <div className={cn('relative mt-2.5 h-9 rounded-full bg-muted', disabled && 'opacity-60')}>
            <div aria-hidden className={cn('absolute inset-y-0 left-0 rounded-full', picked ? 'bg-primary' : 'bg-muted-foreground/25')} style={{ width: `calc(${at} + 1.125rem)` }} />
            {options.map((option, stop) => <span key={option} aria-hidden className={cn('absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full', stop <= index ? 'bg-background/70' : 'bg-muted-foreground/50')}
                style={{ left: `calc(1.125rem + (100% - 2.25rem) * ${stop / last})` }} />)}
            <span aria-hidden className="absolute top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md" style={{ left: at }} />
            <input type="range" min={0} max={options.length - 1} step={1} value={index} disabled={disabled} aria-labelledby={labelId}
                aria-valuetext={picked ? desktopEffortLabel(options[index] ?? '') : 'Default'}
                className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                onChange={event => setDragged(Number(event.target.value))}
                onPointerUp={commit} onKeyUp={commit} onBlur={commit}
                // A click on the stop the thumb already rests on still picks it.
                onClick={() => { if (dragged === null && savedIndex < 0) { const next = options[restingIndex]; if (next) onChoose(next) } }} />
        </div>
    </div>
}
