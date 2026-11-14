'use client'

import { useCallback, useMemo } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts'
import type { EngineUsageBucket } from '@rerun/contracts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../primitives/chart'
import { CHART_FALLBACK_COLOR, CHART_PALETTE, chartColorAt } from './chart-palette'
import { cn } from '../cn'
import { chartBucketLabel, chartCost, chartNumber, chartPercent } from './chart-format'

type Series = { key: string; label: string; color: string }

export type TokenUsageDay = { day: string; totalTokens: number; runCount: number }

type TokenUsageLabels = {
    input: string
    output: string
    cached: string
    cost: string
    tokens: string
    totalCost: string
    totalTokens: string
    runs: (count: number) => string
    loading: string
    noUsage: string
}

type CommonProps = {
    className?: string
    locale?: string
    labels?: TokenUsageLabels
    // Recharts draws itself over ~1.5s in JS, which no CSS lever stops: a screenshot taken while the
    // area is still growing shows a half-drawn chart. Off for anything captured by rerun-shot.
    animated?: boolean
}

export type TokenUsageChartProps =
    | (CommonProps & { metric?: 'tokens' | 'cost'; breakdown?: 'total' | 'inputOutput' | 'model'; chartType?: 'area' | 'bar' | 'donut' | 'stat'; buckets: EngineUsageBucket[] | null; days?: undefined })
    | (CommonProps & { metric?: 'tokens'; breakdown?: 'total'; chartType?: 'area' | 'bar' | 'stat'; days: TokenUsageDay[] | null; buckets?: undefined })

export function TokenUsageChart({ metric = 'tokens', breakdown = 'total', chartType = 'area', buckets, days, className, animated = true, locale, labels }: TokenUsageChartProps) {
    const compact = useMemo(() => chartNumber(locale), [locale])
    const exact = useMemo(() => new Intl.NumberFormat(locale), [locale])
    const formatValue = useCallback((value: number) => metric === 'cost' ? chartCost(value, locale) : compact.format(value), [metric, locale, compact])
    const formatTooltipValue = locale ? (value: number) => metric === 'cost' ? chartCost(value, locale, true) : exact.format(value) : undefined
    const formatDay = (day: string) => chartBucketLabel(day, locale)
    const metricLabel = metric === 'cost' ? labels?.cost ?? 'Cost' : labels?.tokens ?? 'Tokens'

    const daily = useMemo(() => {
        const map = new Map<string, { day: string; tokens: number; cost: number; input: number; output: number; cached: number; runCount: number }>()
        for (const b of buckets ?? []) {
            const d = map.get(b.day) ?? { day: b.day, tokens: 0, cost: 0, input: 0, output: 0, cached: 0, runCount: 0 }
            d.tokens += b.totalTokens
            d.cost += b.costMicros / 1_000_000
            d.input += b.inputTokens
            d.output += b.outputTokens
            d.cached += b.cachedInputTokens
            d.runCount += b.runCount
            map.set(b.day, d)
        }
        return [...map.values()].sort((a, b) => a.day.localeCompare(b.day))
    }, [buckets])

    const measuredDays: { day: string; tokens: number; cost?: number; runCount: number }[] = useMemo(() => {
        if (days === undefined) return daily
        return (days ?? []).map(d => ({ day: d.day, tokens: d.totalTokens, runCount: d.runCount })).sort((a, b) => a.day.localeCompare(b.day))
    }, [daily, days])

    const effectiveBreakdown = breakdown === 'inputOutput' && metric === 'cost' ? 'total' : breakdown

    const models = useMemo(() => {
        const totals = new Map<string, number>()
        for (const b of buckets ?? []) {
            const name = b.model ?? 'unknown'
            const value = metric === 'cost' ? b.costMicros / 1_000_000 : b.totalTokens
            totals.set(name, (totals.get(name) ?? 0) + value)
        }
        return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name, value], i) => ({ name, value, key: `model_${i}`, color: chartColorAt(i) }))
    }, [buckets, metric])

    const { rows, series } = useMemo(() => {
        if (effectiveBreakdown === 'model') {
            const perDay = new Map<string, Map<string, number>>()
            for (const b of buckets ?? []) {
                const name = b.model ?? 'unknown'
                const value = metric === 'cost' ? b.costMicros / 1_000_000 : b.totalTokens
                const inner = perDay.get(b.day) ?? new Map<string, number>()
                inner.set(name, (inner.get(name) ?? 0) + value)
                perDay.set(b.day, inner)
            }
            const s: Series[] = models.map(m => ({ key: m.key, label: m.name, color: m.color }))
            const r = daily.map(d => {
                const row: Record<string, number | string> = { day: d.day }
                for (const m of models) row[m.key] = perDay.get(d.day)?.get(m.name) ?? 0
                return row
            })
            return { rows: r, series: s }
        }
        if (effectiveBreakdown === 'inputOutput') {
            const s: Series[] = [
                { key: 'input', label: labels?.input ?? 'Input', color: CHART_PALETTE[0] },
                { key: 'output', label: labels?.output ?? 'Output', color: CHART_PALETTE[1] },
                { key: 'cached', label: labels?.cached ?? 'Cached', color: CHART_PALETTE[2] },
            ]
            const r = daily.map(d => ({ day: d.day, input: d.input, output: d.output, cached: d.cached }))
            return { rows: r, series: s }
        }
        const s: Series[] = [{ key: 'value', label: metricLabel, color: CHART_PALETTE[0] }]
        const r = measuredDays.map(d => ({ day: d.day, value: metric === 'cost' ? (d.cost ?? 0) : d.tokens }))
        return { rows: r, series: s }
    }, [buckets, daily, measuredDays, models, metric, effectiveBreakdown, labels, metricLabel])

    const chartConfig = useMemo<ChartConfig>(() => Object.fromEntries(series.map(s => [s.key, { label: s.label, color: s.color }])), [series])

    const donutData = useMemo(() => {
        if (effectiveBreakdown === 'inputOutput') {
            const input = daily.reduce((sum, d) => sum + d.input, 0)
            const output = daily.reduce((sum, d) => sum + d.output, 0)
            const cached = daily.reduce((sum, d) => sum + d.cached, 0)
            return [
                { name: labels?.input ?? 'Input', value: input, fill: CHART_PALETTE[0] },
                { name: labels?.output ?? 'Output', value: output, fill: CHART_PALETTE[1] },
                { name: labels?.cached ?? 'Cached', value: cached, fill: CHART_PALETTE[2] },
            ].filter(s => s.value > 0)
        }
        return models.map(m => ({ name: m.name, value: m.value, fill: m.color })).filter(s => s.value > 0)
    }, [daily, models, effectiveBreakdown, labels])

    const stat = useMemo(() => {
        const total = measuredDays.reduce((sum, d) => sum + (metric === 'cost' ? (d.cost ?? 0) : d.tokens), 0)
        const runCount = measuredDays.reduce((sum, d) => sum + d.runCount, 0)
        const sparkRows = measuredDays.map(d => ({ v: metric === 'cost' ? (d.cost ?? 0) : d.tokens }))
        let delta: number | null = null
        if (measuredDays.length >= 2) {
            const mid = Math.floor(measuredDays.length / 2)
            const first = sparkRows.slice(0, mid).reduce((s, r) => s + r.v, 0)
            const second = sparkRows.slice(mid).reduce((s, r) => s + r.v, 0)
            if (first > 0) delta = ((second - first) / first) * 100
        }
        return { total, runCount, sparkRows, delta }
    }, [measuredDays, metric])

    const isEmpty = measuredDays.length === 0
    const loading = days !== undefined ? days === null : buckets === null

    return (
        <div className={cn('h-full w-full p-1', className)}>
            {isEmpty ? (
                <div className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">{loading ? labels?.loading ?? 'Loading...' : labels?.noUsage ?? 'No usage in this period.'}</div>
            ) : chartType === 'stat' ? (
                <div className="flex h-full flex-col justify-center gap-1 px-2">
                    <div className="text-3xl font-semibold leading-none text-foreground">{formatValue(stat.total)}</div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>{metric === 'cost' ? labels?.totalCost ?? 'Total cost' : labels?.totalTokens ?? 'Total tokens'}</span>
                        <span>·</span>
                        <span>{labels?.runs(stat.runCount) ?? `${stat.runCount} runs`}</span>
                        {stat.delta !== null && <span className={stat.delta >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{stat.delta >= 0 ? '▲' : '▼'} {chartPercent(Math.abs(stat.delta) / 100, 0, locale)}</span>}
                    </div>
                    <ChartContainer config={{ v: { label: metricLabel, color: CHART_PALETTE[0] } }} className="mt-2 h-16 w-full aspect-auto">
                        <AreaChart data={stat.sparkRows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                            <Area dataKey="v" type="monotone" stroke="var(--color-v)" fill="var(--color-v)" fillOpacity={0.15} strokeWidth={1.5} dot={false} isAnimationActive={animated} />
                        </AreaChart>
                    </ChartContainer>
                </div>
            ) : chartType === 'donut' ? (
                <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <PieChart>
                        <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel formatValue={formatTooltipValue} />} />
                        <Pie data={donutData} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="82%" paddingAngle={2} strokeWidth={1} isAnimationActive={animated}>
                            {donutData.map((d, i) => (
                                <Cell key={i} fill={d.fill} />
                            ))}
                        </Pie>
                    </PieChart>
                </ChartContainer>
            ) : chartType === 'bar' ? (
                <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="day" tickFormatter={formatDay} tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} />
                        <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={formatValue} />
                        <ChartTooltip content={<ChartTooltipContent labelFormatter={label => formatDay(String(label))} formatValue={formatTooltipValue} />} />
                        {series.map(s => (
                            <Bar key={s.key} dataKey={s.key} stackId="a" fill={`var(--color-${s.key})`} radius={series.length === 1 ? [3, 3, 0, 0] : 0} isAnimationActive={animated} />
                        ))}
                    </BarChart>
                </ChartContainer>
            ) : (
                <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                    <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="day" tickFormatter={formatDay} tickLine={false} axisLine={false} tickMargin={6} minTickGap={16} />
                        <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={formatValue} />
                        <ChartTooltip content={<ChartTooltipContent labelFormatter={label => formatDay(String(label))} formatValue={formatTooltipValue} />} />
                        {series.map(s => (
                            <Area key={s.key} dataKey={s.key} type="monotone" stackId="a" stroke={`var(--color-${s.key})`} fill={`var(--color-${s.key})`} fillOpacity={0.2} strokeWidth={1.5} isAnimationActive={animated} />
                        ))}
                    </AreaChart>
                </ChartContainer>
            )}
        </div>
    )
}
