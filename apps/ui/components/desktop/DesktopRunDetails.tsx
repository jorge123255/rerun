'use client'

import { useEffect, useState } from 'react'
import { formatNumber } from '@rerun/i18n/format'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'
import { SkeletonRows } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { desktopRunDetailsSchema, recordedToolOutcome, type DesktopRunDetailsView, type DesktopRunToolView } from '@/lib/desktop/run-details'
import type { DesktopRunView } from '@/lib/desktop/run-history'

function duration(ms: number, locale: string) {
    return new Intl.NumberFormat(locale, {
        style: 'unit', unit: ms < 1000 ? 'millisecond' : 'second', unitDisplay: 'narrow', minimumFractionDigits: ms < 1000 ? 0 : 1, maximumFractionDigits: 1,
    }).format(ms < 1000 ? ms : ms / 1000)
}
function outcomeText(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

function ToolCalls({ tools }: { tools: DesktopRunToolView[] }) {
    const { language, t } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    return <ul className="space-y-2">
        {tools.map(tool => <li key={tool.id} className="rounded-md border p-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-all font-mono font-medium">{tool.toolName}</span>
                <span className={tool.isError !== 0 ? 'text-destructive' : 'text-muted-foreground'}>{t(`runHistory.${recordedToolOutcome(tool)}`)}</span>
            </div>
            {tool.durationMs !== null && <p className="mt-1 text-muted-foreground">{duration(tool.durationMs, locale)}</p>}
            {tool.resultJson !== null && <details className="mt-2">
                <summary className="cursor-pointer py-1">{t('runHistory.recordedOutcome')}</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{outcomeText(tool.resultJson)}</pre>
            </details>}
        </li>)}
    </ul>
}

export function DesktopRunDetails({ agentId, runId, status }: { agentId: string; runId: string; status: DesktopRunView['status'] }) {
    const { language, t } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const [result, setResult] = useState<{ detail?: DesktopRunDetailsView; error?: 'detailsNotFound' | 'detailsUnavailable' } | null>(null)
    const [revision, setRevision] = useState(0)
    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            try {
                const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/details`, { signal: controller.signal, cache: 'no-store' })
                if (!response.ok) {
                    if (!controller.signal.aborted) setResult(current => ({ detail: current?.detail, error: response.status === 404 ? 'detailsNotFound' : 'detailsUnavailable' }))
                    return
                }
                const detail = desktopRunDetailsSchema.parse(await response.json())
                if (!controller.signal.aborted) setResult({ detail })
            } catch {
                if (!controller.signal.aborted) setResult(current => ({ detail: current?.detail, error: 'detailsUnavailable' }))
            }
        }
        void load()
        return () => controller.abort()
    }, [agentId, runId, status, revision])
    const detail = result?.detail
    const stepNumbers = new Set(detail?.steps.map(step => step.stepNumber))
    const ungrouped = detail?.tools.filter(tool => !stepNumbers.has(tool.stepNumber)) ?? []

    return <div className="space-y-3 border-t px-3 pb-3 pt-2">
        {!result && <div role="status" aria-busy="true"><span className="sr-only">{t('runHistory.detailsLoading')}</span><SkeletonRows rows={3} aria-hidden="true" /></div>}
        {result?.error && <div role="alert" className="text-xs text-destructive">{t(`runHistory.${result.error}`)}{detail && <p>{t('runHistory.detailsStale')}</p>}</div>}
        {detail && (detail.steps.length === 0 && detail.tools.length === 0 ? <p className="text-xs text-muted-foreground">{t('runHistory.detailsEmpty')}</p> : <>
            {detail.steps.length === 0 && <p className="text-xs text-muted-foreground">{t('runHistory.noSteps')}</p>}
            {detail.steps.map(step => <section key={step.id} aria-label={t('runHistory.step', { number: formatNumber(step.stepNumber, locale) })} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <h3 className="font-medium">{t('runHistory.step', { number: formatNumber(step.stepNumber, locale) })}</h3>
                    <span className="break-all text-muted-foreground">{step.finishReason ? t('runHistory.finishReason', { reason: step.finishReason }) : t('runHistory.outcomeNotRecorded')}</span>
                    {step.totalTokens !== null && <span className="text-muted-foreground">{t('runHistory.tokens', { total: formatNumber(step.totalTokens, locale) })}</span>}
                    {step.durationMs !== null && <span className="text-muted-foreground">{duration(step.durationMs, locale)}</span>}
                </div>
                <ToolCalls tools={detail.tools.filter(tool => tool.stepNumber === step.stepNumber)} />
            </section>)}
            {detail.tools.length === 0 && <p className="text-xs text-muted-foreground">{t('runHistory.noTools')}</p>}
            {ungrouped.length > 0 && <section aria-label={t('runHistory.ungroupedTools')} className="space-y-2">
                <h3 className="text-xs font-medium">{t('runHistory.ungroupedTools')}</h3><ToolCalls tools={ungrouped} />
            </section>}
        </>)}
        {result && <Button type="button" variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>{t(result.error ? 'runHistory.detailsRetry' : 'runHistory.detailsRefresh')}</Button>}
    </div>
}
