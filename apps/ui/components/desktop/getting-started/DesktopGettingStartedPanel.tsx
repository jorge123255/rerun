'use client'

import { Button } from '@/components/ui/button'
import { Gauge } from '@/components/ui/gauge'
import { IconBadge } from '@/components/ui/icon-badge'
import { TooltipLabeled } from '@/components/ui/tooltip'
import type { DesktopGettingStartedStep, DesktopGettingStartedStepId } from '@/lib/desktop/getting-started/progress'
import { desktopGettingStartedSummary } from '@/lib/desktop/getting-started/progress'
import { ArrowRightIcon, CheckIcon, EyeOffIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

const PROGRESS_GRADIENT = ['var(--brand)', 'color-mix(in oklab, var(--brand), white 20%)'] as const

export function DesktopGettingStartedProgressMark({ done, total, className }: { done: number; total: number; className?: string }) {
    if (total > 0 && done === total) return <IconBadge tone="green" icon={CheckIcon} className={className} />
    return <Gauge ratio={total === 0 ? 0 : done / total} gradient={PROGRESS_GRADIENT} className={cn('size-5 text-brand', className)} />
}

export function DesktopGettingStartedPanel({ steps, onStep, onHide, className }: {
    steps: readonly DesktopGettingStartedStep[]
    onStep: (id: DesktopGettingStartedStepId) => void
    onHide?: () => void
    className?: string
}) {
    const summary = desktopGettingStartedSummary(steps)
    return (
        <div className={cn('flex flex-col gap-3', className)}>
            <div className="flex items-center gap-2">
                <span className="text-base font-medium">Getting started</span>
                <span className="flex items-center gap-1.5">
                    <DesktopGettingStartedProgressMark done={summary.done} total={summary.total} />
                    <span className="text-xs text-muted-foreground tabular-nums">{summary.done}/{summary.total}</span>
                </span>
                {onHide && (
                    <TooltipLabeled label="Hide">
                        <Button variant="ghost" size="icon-sm" onClick={onHide} aria-label="Hide" className="-my-1 ml-auto text-muted-foreground">
                            <EyeOffIcon />
                        </Button>
                    </TooltipLabeled>
                )}
            </div>
            <ul className="flex flex-col gap-0.5">
                {steps.map(step => (
                    <li key={step.id}>
                        <button
                            type="button"
                            disabled={step.done}
                            onClick={() => onStep(step.id)}
                            className={cn('group flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors', step.done ? 'cursor-default' : 'hover:bg-accent', summary.next?.id === step.id && 'bg-muted/60')}
                        >
                            <span className="pt-px">{step.done ? <IconBadge tone="green" icon={CheckIcon} /> : <IconBadge tone="neutral" glow={false} />}</span>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className={cn('truncate text-sm', step.done ? 'text-muted-foreground line-through decoration-muted-foreground/60' : 'font-medium text-foreground')}>{step.title}</span>
                                {!step.done && <span className="text-xs text-muted-foreground">{step.description}</span>}
                            </span>
                            {!step.done && <ArrowRightIcon className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-opacity', summary.next?.id === step.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')} />}
                        </button>
                    </li>
                ))}
            </ul>
            {summary.complete && (
                <div className="flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2.5">
                    <span className="text-sm font-medium">Your workspace is all set</span>
                    <span className="text-xs text-muted-foreground">Your coworkers can run on their own now.</span>
                </div>
            )}
        </div>
    )
}
