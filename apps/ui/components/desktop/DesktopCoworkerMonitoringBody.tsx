'use client'

import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { STATS_TIME_RANGE_META } from '@rerun/contracts'
import { MonitorCard, StatsChart } from '@rerun/ui/monitoring'
import type { StatsChartType, StatsGroupBy, StatsMetric, StatsPoint } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { desktopMonitoringSchema, MONITORING_RANGES, type DesktopMonitoring, type MonitoringRange } from '@/lib/desktop/monitoring'
import { ActivityIcon, BarChart3Icon, CircleDollarSignIcon, CoinsIcon, CpuIcon, GaugeIcon, HashIcon, Maximize2Icon } from '@/lib/icons'
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
    const isEmpty = !!data && data.runs.length === 0

    const kpiSpecs: (ChartSpec & { points: StatsPoint[] | null })[] = [
        { key: 'kpiRuns', title: 'Runs', icon: HashIcon, metric: 'count', groupBy: 'none', chartType: 'stat', points: data?.runs ?? null },
        ...(data?.cost ? [{ key: 'kpiCost', title: 'Total cost', icon: CircleDollarSignIcon, metric: 'cost' as StatsMetric, groupBy: 'none' as StatsGroupBy, chartType: 'stat' as StatsChartType, points: data.cost }] : []),
        ...(data?.totalTokens ? [{ key: 'kpiTokens', title: 'Total tokens', icon: CoinsIcon, metric: 'totalTokens' as StatsMetric, groupBy: 'none' as StatsGroupBy, chartType: 'stat' as StatsChartType, points: data.totalTokens }] : []),
        { key: 'kpiErrorRate', title: 'Error rate', icon: GaugeIcon, metric: 'errorRate', groupBy: 'none', chartType: 'stat', points: data?.errorRate ?? null },
    ]
    const chartPanels: { key: string; title: string; icon: ComponentType<{ className?: string }>; node: ReactNode }[] = [
        { key: 'runsOverTime', title: 'Runs over time', icon: ActivityIcon, node: <StatsChart dataset="runs" metric="count" groupBy="status" chartType="bar" points={data?.runsByStatus ?? null} /> },
        { key: 'runsByModel', title: 'Runs by model', icon: CpuIcon, node: <StatsChart dataset="runs" metric="count" groupBy="model" chartType="donut" points={data?.runsByModel ?? null} /> },
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
                        title={STATS_TIME_RANGE_META[r].label}
                        className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${range === r ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}
                    >
                        {r}
                    </button>
                ))}
            </div>

            {failed && (
                <div role="alert" className="shrink-0 px-3 pt-3 text-sm text-destructive">
                    Could not load monitoring. The local engine may be unreachable.
                    {data && <p className="mt-1">Showing the last loaded monitoring.</p>}
                    <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => void load()}>Retry</Button>
                </div>
            )}

            {!data && !failed ? (
                <MonitoringSkeleton />
            ) : !data ? null : isEmpty ? (
                <EmptyState
                    className="h-full"
                    icon={BarChart3Icon}
                    title={`No runs in the ${STATS_TIME_RANGE_META[range].label.toLowerCase()}`}
                    description="Choose a different time range to look for earlier runs."
                />
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    <div className="grid grid-cols-2 gap-3">
                        {kpiSpecs.map(spec => (
                            <MonitorCard key={spec.key} className="h-32" title={spec.title} icon={spec.icon}>
                                <StatsChart dataset="runs" metric={spec.metric} groupBy={spec.groupBy} chartType={spec.chartType} points={spec.points} />
                            </MonitorCard>
                        ))}
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                        {chartPanels.map(panel => (
                            <MonitorCard
                                key={panel.key}
                                className="h-56"
                                title={panel.title}
                                icon={panel.icon}
                                action={
                                    <button
                                        type="button"
                                        onClick={() => setExpandedKey(panel.key)}
                                        aria-label={`Expand ${panel.title}`}
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
                <DialogContent className="sm:max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>{expanded?.title}</DialogTitle>
                    </DialogHeader>
                    <div className="h-[60vh] w-full">{expanded?.node}</div>
                </DialogContent>
            </Dialog>
        </div>
    )
}

function MonitoringSkeleton() {
    return (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-32" />
                ))}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-56" />
                ))}
            </div>
        </div>
    )
}
