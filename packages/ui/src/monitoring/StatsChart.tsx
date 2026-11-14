'use client'

import { useCallback, useMemo } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts'
import { STATS_DATASETS, STATS_METRIC_META } from '@rerun/contracts'
import type { StatsChartType, StatsDataset, StatsGroupBy, StatsMetric, StatsPoint } from '@rerun/contracts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../primitives/chart'
import { CHART_FALLBACK_COLOR, CHART_PALETTE, chartColorAt } from './chart-palette'
import { cn } from '../cn'
import { chartBucketLabel, chartNumber, chartPercent, statsValueFormatter } from './chart-format'

const MAX_SERIES = 8

type Series = { key: string; label: string; color: string }

function combine(agg: 'sum' | 'avg', entries: { value: number; count: number }[]): number {
    if (agg === 'sum') return entries.reduce((s, e) => s + e.value, 0)
    const totalCount = entries.reduce((s, e) => s + e.count, 0)
    if (totalCount === 0) return 0
    return entries.reduce((s, e) => s + e.value * e.count, 0) / totalCount
}

type StatsChartLabels = {
    metrics: Readonly<Partial<Record<StatsMetric, string>>>
    rowCount: (dataset: StatsDataset, count: string) => string
    status: Readonly<Partial<Record<string, string>>>
    other: string
    unknown: string
    loading: string
    noData: string
}

export type StatsChartProps = {
    dataset: StatsDataset
    metric: StatsMetric
    groupBy?: StatsGroupBy
    chartType?: StatsChartType
    points: StatsPoint[] | null
    className?: string
    locale?: string
    labels?: StatsChartLabels
}

export function StatsChart({ dataset, metric, groupBy = 'none', chartType = 'area', points, className, locale, labels }: StatsChartProps) {
    const agg = STATS_METRIC_META[metric].agg
    const metricLabel = labels?.metrics[metric] ?? STATS_METRIC_META[metric].label
    const compact = useMemo(() => chartNumber(locale), [locale])
    const formatValue = useMemo(() => statsValueFormatter(metric, locale), [metric, locale])
    const formatTooltipValue = useMemo(() => locale ? statsValueFormatter(metric, locale, true) : undefined, [metric, locale])
    const formatBucket = (bucket: string) => chartBucketLabel(bucket, locale)
    const groupLabel = useCallback((name: string | null) => {
        if (name === null) return labels?.unknown ?? 'unknown'
        return groupBy === 'status' && labels && Object.hasOwn(labels.status, name) ? labels.status[name] ?? name : name
    }, [groupBy, labels])

    const groups = useMemo(() => {
        const totals = new Map<string | null, number>()
        for (const point of points ?? []) {
            const weight = agg === 'avg' ? point.value * point.count : point.value
            totals.set(point.group, (totals.get(point.group) ?? 0) + weight)
        }
        const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1])
        const kept = ranked.slice(0, MAX_SERIES).map(([name], i) => ({ name, key: `g_${i}`, color: chartColorAt(i) }))
        const folded = new Set(ranked.slice(MAX_SERIES).map(([name]) => name))
        return { kept, folded }
    }, [points, agg])

    const hasOther = groups.folded.size > 0

    const { rows, series } = useMemo(() => {
        const buckets = [...new Set((points ?? []).map(p => p.bucket))].sort()
        if (groupBy === 'none') {
            const s: Series[] = [{ key: 'value', label: metricLabel, color: CHART_PALETTE[0] }]
            const r = buckets.map(b => {
                const entries = (points ?? []).filter(p => p.bucket === b)
                return { bucket: b, value: combine(agg, entries) }
            })
            return { rows: r, series: s }
        }
        const s: Series[] = groups.kept.map(g => ({ key: g.key, label: groupLabel(g.name), color: g.color }))
        if (hasOther) s.push({ key: 'g_other', label: labels?.other ?? 'Other', color: CHART_FALLBACK_COLOR })
        const r = buckets.map(b => {
            const inBucket = (points ?? []).filter(p => p.bucket === b)
            const row: Record<string, number | string> = { bucket: b }
            for (const g of groups.kept) {
                row[g.key] = combine(agg, inBucket.filter(p => p.group === g.name))
            }
            if (hasOther) row['g_other'] = combine(agg, inBucket.filter(p => groups.folded.has(p.group)))
            return row
        })
        return { rows: r, series: s }
    }, [points, groups, hasOther, groupBy, metricLabel, agg, labels, groupLabel])

    const chartConfig = useMemo<ChartConfig>(() => Object.fromEntries(series.map(s => [s.key, { label: s.label, color: s.color }])), [series])

    const donutData = useMemo(() => {
        const perGroup = new Map<string | null, StatsPoint[]>()
        const other: StatsPoint[] = []
        for (const point of points ?? []) {
            if (groups.folded.has(point.group)) {
                other.push(point)
                continue
            }
            const entries = perGroup.get(point.group) ?? []
            entries.push(point)
            perGroup.set(point.group, entries)
        }
        const slices = groups.kept.map(group => ({ key: group.key, name: groupLabel(group.name),
            value: combine(agg, perGroup.get(group.name) ?? []), fill: group.color }))
        if (hasOther) slices.push({ key: 'g_other', name: labels?.other ?? 'Other', value: combine(agg, other), fill: CHART_FALLBACK_COLOR })
        return slices.filter(slice => slice.value > 0).sort((a, b) => b.value - a.value)
    }, [points, groups, agg, hasOther, labels, groupLabel])

    const stat = useMemo(() => {
        const all = points ?? []
        const total = combine(agg, all)
        const rowCount = all.reduce((s, e) => s + e.count, 0)
        const buckets = [...new Set(all.map(p => p.bucket))].sort()
        const sparkRows = buckets.map(b => ({ v: combine(agg, all.filter(p => p.bucket === b)) }))
        let delta: number | null = null
        if (buckets.length >= 2) {
            const midpoint = buckets[Math.floor(buckets.length / 2)]
            const first = combine(agg, all.filter(p => p.bucket < midpoint))
            const second = combine(agg, all.filter(p => p.bucket >= midpoint))
            if (first > 0) delta = ((second - first) / first) * 100
        }
        return { total, rowCount, sparkRows, delta }
    }, [points, agg])

    const isEmpty = (points ?? []).length === 0
    const effectiveChart = chartType === 'donut' && groupBy === 'none' ? 'stat' : chartType

    return (
        <div className={cn('h-full w-full p-1', className)}>
            {isEmpty ? (
                <div className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">{points === null ? labels?.loading ?? 'Loading...' : labels?.noData ?? 'No data in this period.'}</div>
            ) : effectiveChart === 'stat' ? (
                <div className="flex h-full flex-col justify-center gap-1 px-2">
                    <div className="text-3xl font-semibold leading-none text-foreground">{formatValue(stat.total)}</div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>{metricLabel}</span>
                        <span>·</span>
                        <span>{labels?.rowCount(dataset, compact.format(stat.rowCount)) ?? `${compact.format(stat.rowCount)} ${STATS_DATASETS[dataset].label.toLowerCase()}`}</span>
                        {stat.delta !== null && <span className={stat.delta >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{stat.delta >= 0 ? '▲' : '▼'} {chartPercent(Math.abs(stat.delta) / 100, 0, locale)}</span>}
                    </div>
                    <ChartContainer config={{ v: { label: metricLabel, color: CHART_PALETTE[0] } }} className="mt-2 h-16 w-full aspect-auto">
                        <AreaChart data={stat.sparkRows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                            <Area dataKey="v" type="monotone" stroke="var(--color-v)" fill="var(--color-v)" fillOpacity={0.15} strokeWidth={1.5} dot={false} />
                        </AreaChart>
                    </ChartContainer>
                </div>
            ) : effectiveChart === 'donut' ? (
                <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <PieChart>
                        <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel formatValue={formatTooltipValue} />} />
                        <Pie data={donutData} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="82%" paddingAngle={2} strokeWidth={1}>
                            {donutData.map(d => (
                                <Cell key={d.key} fill={d.fill} />
                            ))}
                        </Pie>
                    </PieChart>
                </ChartContainer>
            ) : effectiveChart === 'bar' ? (
                <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="bucket" tickFormatter={formatBucket} tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} />
                        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={formatValue} />
                        <ChartTooltip content={<ChartTooltipContent labelFormatter={label => formatBucket(String(label))} formatValue={formatTooltipValue} />} />
                        {series.map(s => (
                            <Bar key={s.key} dataKey={s.key} stackId={agg === 'sum' ? 'a' : undefined} fill={`var(--color-${s.key})`} radius={series.length === 1 ? [3, 3, 0, 0] : 0} />
                        ))}
                    </BarChart>
                </ChartContainer>
            ) : effectiveChart === 'line' ? (
                <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="bucket" tickFormatter={formatBucket} tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} />
                        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={formatValue} />
                        <ChartTooltip content={<ChartTooltipContent labelFormatter={label => formatBucket(String(label))} formatValue={formatTooltipValue} />} />
                        {series.map(s => (
                            <Line key={s.key} dataKey={s.key} type="monotone" stroke={`var(--color-${s.key})`} strokeWidth={1.5} dot={false} />
                        ))}
                    </LineChart>
                </ChartContainer>
            ) : (
                <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="bucket" tickFormatter={formatBucket} tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} />
                        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={formatValue} />
                        <ChartTooltip content={<ChartTooltipContent labelFormatter={label => formatBucket(String(label))} formatValue={formatTooltipValue} />} />
                        {series.map(s => (
                            <Area key={s.key} dataKey={s.key} type="monotone" stackId={agg === 'sum' ? 'a' : undefined} stroke={`var(--color-${s.key})`} fill={`var(--color-${s.key})`} fillOpacity={0.2} strokeWidth={1.5} />
                        ))}
                    </AreaChart>
                </ChartContainer>
            )}
        </div>
    )
}
