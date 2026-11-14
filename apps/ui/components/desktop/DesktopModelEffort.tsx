'use client'

import { useId } from 'react'
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
 * The effort of the model in use. The choice belongs to the model: it applies wherever that model
 * answers, for a coworker and for the Chief of Staff. "Default" leaves the model its own.
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
    const item = (value: string | null, label: string, current: boolean) => <button key={value ?? 'default'} type="button" disabled={disabled || current} aria-pressed={current}
        className={cn('min-h-7 rounded-md border px-2 text-xs', current ? 'border-foreground/40 bg-muted text-foreground' : 'border-border text-muted-foreground hover:bg-muted/40')}
        onClick={() => onChoose(value)}>{label}</button>
    return <div role="group" aria-labelledby={labelId} data-testid="desktop-model-effort" className="space-y-1.5 border-t border-border px-2.5 pb-1 pt-2">
        <p id={labelId} className="text-xs font-medium">Reasoning effort · <span className="font-normal text-muted-foreground">{model}</span></p>
        <div className="flex flex-wrap gap-1">
            {item(null, inherited ? `Default (${desktopEffortLabel(inherited)})` : 'Default', !chosen)}
            {options.map(option => item(option, desktopEffortLabel(option), chosen === option))}
        </div>
    </div>
}
