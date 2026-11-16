'use client'
import { useRef } from 'react'
import { routineChecklistSummary, type DesktopRoutineRunOutcome, type DesktopRoutineWarning } from '@rerun/contracts'
import { cn } from '@/lib/utils'
import { useDesktopLocale } from '../DesktopLocale'

type T = ReturnType<typeof useDesktopLocale>['t']
export type DesktopRoutineLastResult = { status: string; runId?: string; outcome?: DesktopRoutineRunOutcome } | null | undefined

/** What the last run reported, after its status: "Nothing to report", or "3 done, 1 blocked: <reason>". */
export function desktopRoutineOutcomeText(result: DesktopRoutineLastResult, t: T): string | null {
    const outcome = result?.outcome
    if (!outcome) return null
    const pieces: string[] = []
    if (outcome.test) pieces.push(t('routines.testRun'))
    if (outcome.quiet) pieces.push(t('routines.nothingToReport'))
    else if (outcome.checklist) pieces.push(routineChecklistSummary(outcome.checklist, {
        done: t('routines.partDone'), blocked: t('routines.partBlocked'), skipped: t('routines.partSkipped'), open: t('routines.partOpen'), none: t('routines.checklistNone'),
    }))
    return pieces.length ? pieces.join(' · ') : null
}

/** Limits a saved routine already breaks, and the note left when repeated failures switched it off. */
export function DesktopRoutineNotes({ warnings, autoDisabledAt, enabled }: { warnings?: readonly DesktopRoutineWarning[]; autoDisabledAt?: string | null; enabled: boolean }) {
    const { t } = useDesktopLocale()
    const autoOff = Boolean(autoDisabledAt) && !enabled
    if (!autoOff && !warnings?.length) return null
    return <div data-routine-notes className="space-y-1 text-xs">
        {autoOff && <p role="status" data-routine-auto-off className="text-destructive">{t('routines.autoOff')}</p>}
        {warnings?.includes('interval') && <p role="status" data-routine-warning="interval" className="text-muted-foreground">{t('routines.warnInterval')}</p>}
        {warnings?.includes('cap') && <p role="status" data-routine-warning="cap" className="text-muted-foreground">{t('routines.warnCap')}</p>}
    </div>
}

/** Steps tick in this far apart, and all of them have landed within about a second. */
export const ROUTINE_STEP_GAP_MS = 60
export const ROUTINE_STEPS_WITHIN_MS = 1000
export function routineStepDelayMs(index: number, count: number): number {
    return Math.round(index * Math.min(ROUTINE_STEP_GAP_MS, ROUTINE_STEPS_WITHIN_MS / Math.max(1, count)))
}

const STEP_TONE = {
    done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    blocked: 'bg-red-500/15 text-red-700 dark:text-red-300',
    skipped: 'bg-muted text-muted-foreground',
    open: 'bg-muted text-muted-foreground',
} as const
const STEP_LABEL = { done: 'routines.stepDone', blocked: 'routines.stepBlocked', skipped: 'routines.stepSkipped', open: 'routines.stepOpen' } as const

/**
 * The last run's checklist, one line a part: Done, Blocked or Skipped, and why. A result that was
 * already there when the view was opened is shown as it is. One that arrives while the view is open
 * (the run just finished) has its steps tick in one after another. With "Reduce motion" on they
 * are all there at once.
 */
export function DesktopRoutineChecklistSteps({ result, className }: { result: DesktopRoutineLastResult; className?: string }) {
    const { t } = useDesktopLocale()
    const checklist = result?.outcome && !result.outcome.quiet && result.outcome.checklist?.reported ? result.outcome.checklist : null
    // Which run, and what it reported: polling that brings the same result back changes nothing.
    const key = checklist ? JSON.stringify([result?.runId ?? null, checklist.parts.map(part => [part.number, part.status])]) : null
    const opened = useRef(key)
    if (!checklist || !key) return null
    const live = key !== opened.current
    return <ol data-routine-checklist={live ? 'live' : 'settled'} aria-label={t('routines.checklistSteps')} className={cn('space-y-1 text-xs', className)}>
        {checklist.parts.map((part, index) => <li key={`${key}:${part.number}`} data-routine-step={part.status}
            className={cn('flex items-start gap-2', live && 'animate-in fade-in-0 slide-in-from-left-2 duration-200 ease-out fill-mode-backwards motion-reduce:animate-none')}
            style={live ? { animationDelay: `${routineStepDelayMs(index, checklist.parts.length)}ms` } : undefined}>
            <span className={cn('mt-px shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium', STEP_TONE[part.status])}>{t(STEP_LABEL[part.status])}</span>
            <span className="min-w-0 flex-1 wrap-anywhere">{part.text}{part.reason && <span className="text-muted-foreground">{` · ${part.reason}`}</span>}</span>
        </li>)}
    </ol>
}
