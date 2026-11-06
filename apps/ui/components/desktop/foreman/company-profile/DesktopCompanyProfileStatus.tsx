'use client'

import type { DesktopCompanyProfileAttempt, DesktopCompanyProfileCorrection } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { DESKTOP_DISCOVERY_SOURCE_LABELS } from '@/lib/desktop/foreman-client'
import type { DesktopCompanyProfileKind } from '@/lib/desktop/company-profile/use-desktop-company-profile'
import { DISCOVERY_CARD_CLASS } from '../discoveries/DesktopDiscoveryCard'

const STAGE_LABELS = {
    queued: 'Preparing company analysis…',
    reading_site: 'Reading the public website…',
    analyzing_evidence: 'Reviewing the evidence…',
    projecting_profile: 'Putting the company profile together…',
    settled: 'Company analysis settled.',
} as const

export function DesktopCompanyProfileStatus({ attempts, error, onRetry, onStop, onCorrection, onRefresh }: {
    attempts: (DesktopCompanyProfileAttempt | null)[]
    error: string | null
    onRetry: (kind: DesktopCompanyProfileKind) => void
    onStop: (kind: DesktopCompanyProfileKind) => void
    onCorrection?: (correction: DesktopCompanyProfileCorrection) => void
    onRefresh: () => void
}) {
    const visible = attempts.filter((attempt): attempt is DesktopCompanyProfileAttempt => !!attempt && (attempt.status === 'pending' || attempt.status !== 'succeeded'))
    if (!visible.length && !error) return null
    return <div className="pointer-events-auto absolute left-4 top-20 z-20 flex max-h-[60vh] w-72 flex-col gap-2 overflow-y-auto">
        {error && <section className={DISCOVERY_CARD_CLASS} role="alert">
            <p className="text-xs text-destructive">{error}</p>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onRefresh}>Refresh company profile</Button>
        </section>}
        {visible.map(attempt => {
            const outcome = attempt.outcome
            const correction = outcome && 'correction' in outcome ? outcome.correction : null
            return <section key={attempt.requestId} className={DISCOVERY_CARD_CLASS} aria-label={`${attempt.kind === 'decide' ? 'Industry decision' : 'Company profile'} status`}>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                    <span>{attempt.kind === 'decide' ? 'Industry decision' : 'Company profile'}</span>
                    <span className="ml-auto text-[10px]">{attempt.status}</span>
                </div>
                {attempt.status === 'pending' ? <>
                    <p className="text-xs text-muted-foreground">{STAGE_LABELS[attempt.progress.stage]}</p>
                    {attempt.progress.sources.length > 0 && <ul className="mt-2 space-y-1">{attempt.progress.sources.map(source => <li key={source.source} className="text-[10px] text-muted-foreground">
                        {DESKTOP_DISCOVERY_SOURCE_LABELS[source.source]} · {source.state}{source.reason ? ` · ${source.reason}` : ''}
                    </li>)}</ul>}
                    <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => onStop(attempt.kind)}>Stop analysis</Button>
                </> : <>
                    {outcome && 'message' in outcome && <p className="text-xs text-muted-foreground">{outcome.message}</p>}
                    {correction && <p className="mt-2 text-xs">{correction.prompt}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                        {correction && onCorrection && <Button type="button" size="sm" variant="outline" onClick={() => onCorrection(correction)}>Review original question</Button>}
                        <Button type="button" size="sm" variant="outline" onClick={() => onRetry(attempt.kind)}>Try again</Button>
                    </div>
                </>}
            </section>
        })}
    </div>
}
