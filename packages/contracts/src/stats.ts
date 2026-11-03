import { z } from 'zod'

export const statsDatasetSchema = z.enum(['runs', 'runSteps', 'toolCalls', 'sessions'])
export type StatsDataset = z.infer<typeof statsDatasetSchema>

export const statsMetricSchema = z.enum([
    'count',
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'reasoningTokens',
    'cost',
    'avgDurationMs',
    'errorCount',
    'errorRate',
    'recordedTokenRuns',
    'recordedCostRuns',
])
export type StatsMetric = z.infer<typeof statsMetricSchema>

export const statsGroupBySchema = z.enum(['none', 'model', 'status', 'triggerSource', 'finishReason', 'stepNumber', 'toolName', 'source'])
export type StatsGroupBy = z.infer<typeof statsGroupBySchema>

export const statsTimeRangeSchema = z.enum(['24h', '7d', '30d', '90d', 'all'])
export type StatsTimeRange = z.infer<typeof statsTimeRangeSchema>

export const statsRunStatusFilterSchema = z.enum(['all', 'done', 'error', 'cancelled', 'running'])
export type StatsRunStatusFilter = z.infer<typeof statsRunStatusFilterSchema>

// Fenêtre de l'agrégat d'usage (`/agents/:id/usage`), plus courte que celle des stats: pas de 90d.
export const usageTimeRangeSchema = z.enum(['24h', '7d', '30d', 'all'])
export type UsageTimeRange = z.infer<typeof usageTimeRangeSchema>

export const statsChartTypeSchema = z.enum(['area', 'bar', 'line', 'donut', 'stat'])
export type StatsChartType = z.infer<typeof statsChartTypeSchema>

export const statsQuerySchema = z.object({
    dataset: statsDatasetSchema,
    metric: statsMetricSchema,
    groupBy: statsGroupBySchema.default('none'),
    range: statsTimeRangeSchema.default('7d'),
    status: statsRunStatusFilterSchema.optional(),
})
export type StatsQuery = z.infer<typeof statsQuerySchema>

export const statsPointSchema = z.object({
    bucket: z.string(),
    group: z.string().nullable(),
    value: z.number(),
    count: z.number(),
})
export type StatsPoint = z.infer<typeof statsPointSchema>

export const statsResponseSchema = z.object({ points: z.array(statsPointSchema) })

export type StatsUnit = 'count' | 'tokens' | 'costMicros' | 'ms' | 'ratio'
export type StatsAgg = 'sum' | 'avg'

export const STATS_METRIC_META: Record<StatsMetric, { label: string; unit: StatsUnit; agg: StatsAgg }> = {
    count: { label: 'Count', unit: 'count', agg: 'sum' },
    totalTokens: { label: 'Total tokens', unit: 'tokens', agg: 'sum' },
    inputTokens: { label: 'Input tokens', unit: 'tokens', agg: 'sum' },
    outputTokens: { label: 'Output tokens', unit: 'tokens', agg: 'sum' },
    cachedInputTokens: { label: 'Cached tokens', unit: 'tokens', agg: 'sum' },
    reasoningTokens: { label: 'Reasoning tokens', unit: 'tokens', agg: 'sum' },
    cost: { label: 'Cost', unit: 'costMicros', agg: 'sum' },
    avgDurationMs: { label: 'Avg duration', unit: 'ms', agg: 'avg' },
    errorCount: { label: 'Errors', unit: 'count', agg: 'sum' },
    errorRate: { label: 'Error rate', unit: 'ratio', agg: 'avg' },
    recordedTokenRuns: { label: 'Runs with recorded tokens', unit: 'count', agg: 'sum' },
    recordedCostRuns: { label: 'Runs with recorded cost', unit: 'count', agg: 'sum' },
}

export const STATS_TIME_RANGE_META: Record<StatsTimeRange, { label: string }> = {
    '24h': { label: 'Last 24 hours' },
    '7d': { label: 'Last 7 days' },
    '30d': { label: 'Last 30 days' },
    '90d': { label: 'Last 90 days' },
    all: { label: 'All time' },
}

export const STATS_DATASETS: Record<
    StatsDataset,
    {
        label: string
        metrics: StatsMetric[]
        groupBys: Exclude<StatsGroupBy, 'none'>[]
        supportsStatusFilter: boolean
    }
> = {
    runs: {
        label: 'Runs',
        metrics: ['count', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'cost', 'avgDurationMs', 'errorCount', 'errorRate', 'recordedTokenRuns', 'recordedCostRuns'],
        groupBys: ['model', 'status', 'triggerSource'],
        supportsStatusFilter: true,
    },
    runSteps: {
        label: 'Run steps',
        metrics: ['count', 'totalTokens', 'inputTokens', 'outputTokens', 'avgDurationMs'],
        groupBys: ['model', 'finishReason', 'stepNumber'],
        supportsStatusFilter: false,
    },
    toolCalls: {
        label: 'Tool calls',
        metrics: ['count', 'errorCount', 'errorRate', 'avgDurationMs'],
        groupBys: ['toolName'],
        supportsStatusFilter: false,
    },
    sessions: {
        label: 'Sessions',
        metrics: ['count'],
        groupBys: ['source', 'status'],
        supportsStatusFilter: false,
    },
}

export function isValidStatsCombo(dataset: StatsDataset, metric: StatsMetric, groupBy: StatsGroupBy): boolean {
    const def = STATS_DATASETS[dataset]
    return def.metrics.includes(metric) && (groupBy === 'none' || def.groupBys.includes(groupBy))
}
