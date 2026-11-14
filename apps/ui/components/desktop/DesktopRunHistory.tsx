'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RunStatusBadge } from '@rerun/ui/monitoring'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { DESKTOP_RUN_HISTORY_LIMIT, desktopRunsSchema, recordedRunUsage, type DesktopRunView } from '@/lib/desktop/run-history'
import { fullDateTime, formatNumber } from '@rerun/i18n/format'
import { EmptyState } from '@/components/ui/empty-state'
import { PANEL_CARD, PANEL_CARD_INTERACTIVE } from '@/components/ui/panel-row'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'
import type { DesktopAgentView } from './DesktopApp'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronRightIcon, ScrollTextIcon, HistoryIcon } from '@/lib/icons'
import { DesktopRunDetails } from './DesktopRunDetails'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'

function RecordedTime({ value, fallback }: { value: string | null; fallback: string }) {
    const { language } = useDesktopLocale()
    return value && Number.isFinite(Date.parse(value))
        ? <time dateTime={value} suppressHydrationWarning>{fullDateTime(value, desktopLocaleTag(language.locale))}</time>
        : <span>{fallback}</span>
}

function RunUsage({ run }: { run: DesktopRunView }) {
    const { language, t } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const usage = recordedRunUsage(run)
    const parts = [
        usage.total !== null ? t('runHistory.tokens', { total: formatNumber(usage.total, locale) }) : null,
        usage.input !== null ? t('runHistory.input', { value: usage.input }) : null,
        usage.output !== null ? t('runHistory.output', { value: usage.output }) : null,
        usage.cachedInput !== null ? t('runHistory.cachedInput', { value: usage.cachedInput }) : null,
        usage.reasoning !== null ? t('runHistory.reasoning', { value: usage.reasoning }) : null,
        usage.cost !== null ? t('runHistory.cost', { value: new Intl.NumberFormat(locale, {
            style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 6,
        }).format(usage.cost) }) : null,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : t('runHistory.usageUnavailable')
}

function RunRow({ agentId, run }: { agentId: string; run: DesktopRunView }) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useState(false)
    const trigger = run.triggerSlug ?? run.triggerSource
    return <li>
        <Collapsible open={open} onOpenChange={setOpen} className={cn(PANEL_CARD, 'overflow-hidden')}>
            <CollapsibleTrigger className={cn('group flex w-full flex-col gap-2 p-3 text-left', PANEL_CARD_INTERACTIVE)}>
                <div className="flex w-full flex-wrap items-center gap-2">
                    <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                    <span className="min-w-0 flex-1 text-sm font-medium">{t('runHistory.started')} <RecordedTime value={run.startedAt} fallback={t('runHistory.notRecorded')} /></span>
                    <RunStatusBadge status={run.status} label={t(`runHistory.status.${run.status}`)} />
                </div>
                <span className="text-xs text-muted-foreground">{t('runHistory.finished')} <RecordedTime value={run.finishedAt} fallback={t(run.status === 'running' ? 'runHistory.inProgress' : 'runHistory.notRecorded')} /></span>
                <span className="break-words text-xs text-muted-foreground">{t('runHistory.stepCount', { count: run.stepCount })} · <RunUsage run={run} /></span>
                {(run.provider || run.model) && <span className="break-all text-xs text-muted-foreground">{[run.provider, run.model].filter(Boolean).join(' · ')}</span>}
                {trigger && <span className="break-words text-xs text-muted-foreground">{trigger}</span>}
            </CollapsibleTrigger>
            <CollapsibleContent>{open && <DesktopRunDetails agentId={agentId} runId={run.id} status={run.status} />}</CollapsibleContent>
        </Collapsible>
    </li>
}

export function DesktopRunHistoryBody({ agentId, dismiss }: { agentId: string; dismiss?: ReactNode }) {
    const { t } = useDesktopLocale()
    const [runs, setRuns] = useState<DesktopRunView[] | null>(null)
    const [error, setError] = useState(false)
    const read = useRef<AbortController | null>(null)
    const load = useCallback(async () => {
        if (read.current && !read.current.signal.aborted) return
        const controller = new AbortController()
        read.current = controller
        try {
            const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/runs`, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error('Run history unavailable')
            const body = desktopRunsSchema.parse(await response.json())
            if (!controller.signal.aborted) { setRuns(body.runs); setError(false) }
        } catch {
            if (!controller.signal.aborted) setError(true)
        } finally {
            if (read.current === controller) read.current = null
        }
    }, [agentId])
    useVisibleInterval(load, 3000)
    useEffect(() => () => read.current?.abort(), [])

    return <>
        {error && <div role="alert" className="shrink-0 text-sm text-destructive">{t('runHistory.unavailable')}{runs && <p className="mt-1">{t('runHistory.stale')}</p>}</div>}
        <div className="min-h-0 overflow-y-auto">
            {runs === null && !error ? <div role="status" aria-busy="true">
                <span className="sr-only">{t('runHistory.loading')}</span>
                <SkeletonPanelRows rows={6} badge aria-hidden="true" />
            </div>
                : runs?.length === 0 && !error ? <EmptyState icon={ScrollTextIcon} title={t('runHistory.empty.title')} description={t('runHistory.empty.description')} />
                : runs && <ul aria-label={t('runHistory.title')} className="space-y-3">
                    {runs.map(run => <RunRow key={run.id} agentId={agentId} run={run} />)}
                </ul>}
        </div>
        <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={() => void load()}>{t(error ? 'runHistory.retry' : 'runHistory.refresh')}</Button>
            {dismiss}
        </DialogFooter>
    </>
}

export function DesktopRunHistory({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">{t('runHistory.button')}</Button></DialogTrigger>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl">
            <DialogHeaderBar icon={HistoryIcon} title={t('runHistory.title')} description={t('runHistory.description', { limit: DESKTOP_RUN_HISTORY_LIMIT, name: agent.name })} />
            {open && <DesktopRunHistoryBody key={agent.id} agentId={agent.id}
                dismiss={<DialogClose asChild><Button type="button">{t('runHistory.close')}</Button></DialogClose>} />}
        </DialogContent>
    </Dialog>
}
