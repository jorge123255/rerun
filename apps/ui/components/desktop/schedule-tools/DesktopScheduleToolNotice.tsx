'use client'

import { useDesktopLocale } from '../DesktopLocale'

/** Shows a coworker routine-tool result. It has no actions and does not run, reload, or edit a routine. */
export function DesktopScheduleToolNotice({ outcome, text }: { outcome: 'committed' | 'rejected' | 'cancelled' | 'uncertain'; text: string }) {
    const { t } = useDesktopLocale()
    return <p data-outcome={outcome} role={outcome === 'committed' ? 'status' : 'alert'}>{t(`routines.coworker.toolOutcome.${outcome}`)}. {text} {t('routines.coworker.toolNoRun')}</p>
}
