'use client'
import { routineChecklistSummary, type DesktopRoutineRunOutcome, type DesktopRoutineWarning } from '@rerun/contracts'
import { useDesktopLocale } from '../DesktopLocale'

type T = ReturnType<typeof useDesktopLocale>['t']
export type DesktopRoutineLastResult = { status: string; outcome?: DesktopRoutineRunOutcome } | null | undefined

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
