'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { MonitorCard, StatsChart, TokenUsageChart } from '@rerun/ui/monitoring'
import type { StatsChartType, StatsGroupBy, StatsMetric, StatsPoint } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { dailyTokenUsage, desktopMonitoringSchema, MONITORING_RANGES, type DesktopMonitoring, type MonitoringRange } from '@/lib/desktop/monitoring'
import { ActivityIcon, AlertTriangleIcon, BarChart3Icon, CircleDollarSignIcon, CoinsIcon, CpuIcon, GaugeIcon, HashIcon, Maximize2Icon, TimerIcon, WrenchIcon } from '@/lib/icons'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'
import type { DesktopAgentView } from './DesktopApp'

const POLL_MS = 30000

type ChartSpec = {
    key: string
    title: string
    icon: ComponentType<{ className?: string }>
    metric: StatsMetric
    groupBy: StatsGroupBy
    chartType: StatsChartType
}

type Loaded = { key: string; data: DesktopMonitoring }

export function DesktopCoworkerMonitoringBody({ agent }: { agent: DesktopAgentView }) {
    const { language, t } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const kit = language.messages.monitoring.kit
    const statsLabels = useMemo(() => ({
        ...kit.chart, metrics: kit.metrics, status: kit.runStatus, unknown: language.messages.monitoring.unknown,
        rowCount: (dataset: keyof typeof kit.chart.rowCount, count: string) => t(`monitoring.kit.chart.rowCount.${dataset}`, { count }),
    }), [kit, language.messages.monitoring.unknown, t])
    const usageLabels = useMemo(() => ({
        ...kit.usage, loading: kit.chart.loading, runs: (count: number) => t('monitoring.kit.usage.runs', { count }),
    }), [kit, t])
    const [range, setRange] = useState<MonitoringRange>('7d')
    const key = `${agent.id}:${range}`
    const keyRef = useRef(key)
    useEffect(() => {
        keyRef.current = key
    }, [key])
    const [loaded, setLoaded] = useState<Loaded | null>(null)
    const [failedKey, setFailedKey] = useState<string | null>(null)
    const [expandedKey, setExpandedKey] = useState<string | null>(null)
    const inflight = useRef<{ key: string; controller: AbortController } | null>(null)

    const load = useCallback(async () => {
        const requestKey = `${agent.id}:${range}`
        if (inflight.current?.key === requestKey && !inflight.current.controller.signal.aborted) return
        inflight.current?.controller.abort()
        const controller = new AbortController()
        inflight.current = { key: requestKey, controller }
        try {
            const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agent.id)}/monitoring?range=${range}`, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error('Monitoring unavailable')
            const body = desktopMonitoringSchema.parse(await response.json())
            if (controller.signal.aborted || keyRef.current !== requestKey || body.agentId !== agent.id || body.range !== range) return
            setLoaded({ key: requestKey, data: body })
            setFailedKey(null)
        } catch {
            if (!controller.signal.aborted && keyRef.current === requestKey) setFailedKey(requestKey)
        } finally {
            if (inflight.current?.controller === controller) inflight.current = null
        }
    }, [agent.id, range])

    useVisibleInterval(load, POLL_MS)
    useEffect(() => () => inflight.current?.controller.abort(), [])

    const data = loaded?.key === key ? loaded.data : null
    const failed = failedKey === key
    const isEmpty = !!data && data.runs.length === 0 && data.toolCalls.length === 0
    const rangeLabel = t(`monitoring.ranges.${range}.label`)
    const emptyRange = language.locale === 'en' ? rangeLabel.toLowerCase() : rangeLabel

    const kpiSpecs: (ChartSpec & { points: StatsPoint[] | null })[] = [
        { key: 'kpiRuns', title: t('monitoring.charts.kpiRuns'), icon: HashIcon, metric: 'count', groupBy: 'none', chartType: 'stat', points: data?.runs ?? null },
        ...(data?.cost ? [{ key: 'kpiCost', title: t('monitoring.charts.kpiCost'), icon: CircleDollarSignIcon, metric: 'cost' as StatsMetric, groupBy: 'none' as StatsGroupBy, chartType: 'stat' as StatsChartType, points: data.cost }] : []),
        ...(data?.totalTokens ? [{ key: 'kpiTokens', title: t('monitoring.charts.kpiTokens'), icon: CoinsIcon, metric: 'totalTokens' as StatsMetric, groupBy: 'none' as StatsGroupBy, chartType: 'stat' as StatsChartType, points: data.totalTokens }] : []),
        { key: 'kpiErrorRate', title: t('monitoring.charts.kpiErrorRate'), icon: GaugeIcon, metric: 'errorRate', groupBy: 'none', chartType: 'stat', points: data?.errorRate ?? null },
    ]
    const chartMessage = (text: string) => <div className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">{text}</div>
    const toolChart = (metric: StatsMetric, points: StatsPoint[] | null) =>
        points !== null && points.length === 0
            ? chartMessage(t('monitoring.noToolCalls'))
            : <StatsChart locale={locale} labels={statsLabels} dataset="toolCalls" metric={metric} groupBy="toolName" chartType="bar" points={points} />
    const tokenUsageNode = data === null
        ? <TokenUsageChart locale={locale} labels={usageLabels} metric="tokens" breakdown="total" chartType="area" days={null} />
        : data.totalTokens === null
            ? chartMessage(t('monitoring.partialTokens'))
            : <TokenUsageChart locale={locale} labels={usageLabels} metric="tokens" breakdown="total" chartType="area" days={dailyTokenUsage(data.totalTokens)} />
    const chartPanels: { key: string; title: string; subtitle?: string; icon: ComponentType<{ className?: string }>; node: ReactNode }[] = [
        { key: 'tokenUsage', title: t('monitoring.tokenUsage.title'), subtitle: t('monitoring.tokenUsage.subtitle'), icon: CoinsIcon, node: tokenUsageNode },
        { key: 'runsOverTime', title: t('monitoring.charts.runsOverTime'), icon: ActivityIcon, node: <StatsChart locale={locale} labels={statsLabels} dataset="runs" metric="count" groupBy="status" chartType="bar" points={data?.runsByStatus ?? null} /> },
        { key: 'costOverTime', title: t('monitoring.charts.costOverTime'), icon: CircleDollarSignIcon, node: data?.cost === null ? chartMessage(t('monitoring.partialCost')) : <StatsChart locale={locale} labels={statsLabels} dataset="runs" metric="cost" groupBy="none" chartType="area" points={data?.cost ?? null} /> },
        { key: 'avgDuration', title: t('monitoring.charts.avgDuration'), icon: TimerIcon, node: <StatsChart locale={locale} labels={statsLabels} dataset="runs" metric="avgDurationMs" groupBy="none" chartType="line" points={data?.avgDuration ?? null} /> },
        { key: 'runsByModel', title: t('monitoring.charts.runsByModel'), icon: CpuIcon, node: <StatsChart locale={locale} labels={statsLabels} dataset="runs" metric="count" groupBy="model" chartType="donut" points={data?.runsByModel ?? null} /> },
        { key: 'topTools', title: t('monitoring.charts.topTools'), icon: WrenchIcon, node: toolChart('count', data?.toolCalls ?? null) },
        { key: 'toolErrors', title: t('monitoring.charts.toolErrors'), icon: AlertTriangleIcon, node: toolChart('errorCount', data?.toolErrors ?? null) },
    ]
    const expanded = chartPanels.find(panel => panel.key === expandedKey) ?? null

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-end gap-1 border-b border-border px-3 py-2">
                {MONITORING_RANGES.map(r => (
                    <button
                        key={r}
                        type="button"
                        aria-pressed={range === r}
                        onClick={() => setRange(r)}
                        title={t(`monitoring.ranges.${r}.label`)}
                        className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${range === r ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}
                    >
                        {t(`monitoring.ranges.${r}.short`)}
                    </button>
                ))}
            </div>

            {failed && (
                <div role="alert" className="shrink-0 px-3 pt-3 text-sm text-destructive">
                    {t('monitoring.unavailable')}
                    {data && <p className="mt-1">{t('monitoring.stale')}</p>}
                    <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => void load()}>{t('monitoring.retry')}</Button>
                </div>
            )}

            {!data && !failed ? (
                <MonitoringSkeleton label={t('monitoring.kit.chart.loading')} />
            ) : !data ? null : isEmpty ? (
                <EmptyState
                    className="h-full"
                    icon={BarChart3Icon}
                    title={t('monitoring.emptyRange', { range: emptyRange })}
                    description={t('monitoring.emptyDescription')}
                />
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    <div className="grid grid-cols-2 gap-3">
                        {kpiSpecs.map(spec => (
                            <MonitorCard key={spec.key} className="h-32" title={spec.title} icon={spec.icon}>
                                <StatsChart locale={locale} labels={statsLabels} dataset="runs" metric={spec.metric} groupBy={spec.groupBy} chartType={spec.chartType} points={spec.points} />
                            </MonitorCard>
                        ))}
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                        {chartPanels.map(panel => (
                            <MonitorCard
                                key={panel.key}
                                className="h-56"
                                title={panel.title}
                                subtitle={panel.subtitle}
                                icon={panel.icon}
                                action={
                                    <button
                                        type="button"
                                        onClick={() => setExpandedKey(panel.key)}
                                        aria-label={t('monitoring.expand', { title: panel.title })}
                                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                                    >
                                        <Maximize2Icon className="size-3.5" />
                                    </button>
                                }
                            >
                                {panel.node}
                            </MonitorCard>
                        ))}
                    </div>
                </div>
            )}

            <Dialog open={!!expanded} onOpenChange={open => !open && setExpandedKey(null)}>
                <DialogContent closeLabel={t('monitoring.close')} aria-describedby={undefined} className="sm:max-w-3xl">
                    <DialogHeaderBar icon={ActivityIcon} title={expanded?.title} />
                    <div className="h-[60vh] w-full">{expanded?.node}</div>
                </DialogContent>
            </Dialog>
        </div>
    )
}

function MonitoringSkeleton({ label }: { label: string }) {
    return (
        <div role="status" aria-busy="true" className="min-h-0 flex-1 overflow-y-auto p-3">
            <span className="sr-only">{label}</span>
            <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-32" />
                ))}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                {Array.from({ length: 7 }).map((_, i) => (
                    <Skeleton key={i} className="h-56" />
                ))}
            </div>
        </div>
    )
}
