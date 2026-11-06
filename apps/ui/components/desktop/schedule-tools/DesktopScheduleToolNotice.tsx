'use client'

const LABELS = { committed: 'Committed', rejected: 'Rejected', cancelled: 'Cancelled', uncertain: 'Uncertain' } as const

/** Shows a coworker routine-tool result. It has no actions and does not run, reload, or edit a routine. */
export function DesktopScheduleToolNotice({ outcome, text }: { outcome: keyof typeof LABELS; text: string }) {
    return <p data-outcome={outcome} role={outcome === 'committed' ? 'status' : 'alert'}>{LABELS[outcome]}. {text} This does not run the routine.</p>
}
