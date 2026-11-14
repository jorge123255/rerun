'use client'

import { Gauge } from '@/components/ui/gauge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'

export type ContextUsage = {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
}

export type ContextProps = {
    usedTokens: number
    maxTokens?: number
    usage?: ContextUsage
    modelId?: string
    locale?: string
    labels?: ContextLabels
}

type ContextLabels = { usedLabel: (percent: number) => string; title: string; input: string; cached: string; reasoning: string; output: string; total: string }
const defaultLabels: ContextLabels = { usedLabel: percent => `Context used: ${percent}%`, title: 'Context', input: 'Input', cached: 'Cached',
    reasoning: 'Reasoning', output: 'Output', total: 'Total' }

function toneFor(ratio: number): string {
    return ratio >= 0.85 ? 'text-destructive' : 'text-amber-500'
}

// The gauge only shows once the context is getting short: below this there is nothing to act on.
const CONTEXT_GAUGE_FROM = 0.75

function UsageRow({ label, value, locale }: { label: string; value: number; locale?: string }) {
    if (!value) return null
    return (
        <div className="flex items-center justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <span className="tabular-nums">{value.toLocaleString(locale)}</span>
        </div>
    )
}

export function Context({ usedTokens, maxTokens, usage, locale, labels = defaultLabels }: ContextProps) {
    if (!maxTokens || usedTokens <= 0) return null
    const ratio = usedTokens / maxTokens
    if (ratio < CONTEXT_GAUGE_FROM) return null
    const percent = Math.round(ratio * 100)
    const tone = toneFor(ratio)

    return (
        <HoverCard openDelay={120} closeDelay={80}>
            <HoverCardTrigger asChild>
                <button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label={labels.usedLabel(percent)}>
                    <Gauge ratio={ratio} className={tone} />
                </button>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-56">
                <div className="mb-2 flex items-center justify-between gap-4">
                    <span className="text-xs font-medium">{labels.title}</span>
                    <span className={cn('text-xs font-medium tabular-nums', tone)}>{percent}%</span>
                </div>
                <div className="space-y-1">
                    <UsageRow label={labels.input} value={usage?.inputTokens ?? 0} locale={locale} />
                    <UsageRow label={labels.cached} value={usage?.cachedInputTokens ?? 0} locale={locale} />
                    <UsageRow label={labels.reasoning} value={usage?.reasoningTokens ?? 0} locale={locale} />
                    <UsageRow label={labels.output} value={usage?.outputTokens ?? 0} locale={locale} />
                    <div className="mt-1 flex items-center justify-between gap-4 border-t border-border pt-1 text-xs">
                        <span className="text-muted-foreground">{labels.total}</span>
                        <span className="tabular-nums">
                            {usedTokens.toLocaleString(locale)} / {maxTokens.toLocaleString(locale)}
                        </span>
                    </div>
                </div>
            </HoverCardContent>
        </HoverCard>
    )
}
