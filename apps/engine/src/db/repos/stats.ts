import { and, asc, eq, gte, isNotNull, lte, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { StatsDataset, StatsGroupBy, StatsMetric, StatsPoint, StatsRunStatusFilter } from '@rerun/contracts'
import { getSystemDb } from '../systemDb.js'
import { runs, runSteps, sessions, toolCalls } from '../schema.js'
import { INTERRUPTED_RUN_ERROR } from './runs.js'

type DatasetDef = {
    table: SQLiteTable
    agentId: SQLiteColumn
    timeColumn: SQLiteColumn
    metrics: Partial<Record<StatsMetric, SQL<number>>>
    groups: Partial<Record<StatsGroupBy, SQL<string | null>>>
    extraConditions?: Partial<Record<StatsMetric, SQL>>
}

const runsDurationMs = sql<number>`coalesce(avg((julianday(${runs.finishedAt}) - julianday(${runs.startedAt})) * 86400000.0), 0)`

// The SDK's run totals can sum only the steps that supplied usage. Count a run as
// measured only when every recorded step supports the exact total on its run row.
function recordedRuns(total: SQLiteColumn, stepValue: SQL): SQL<number> {
    const measuredTotal = sql`(
        select case when count(*) = ${runs.stepCount}
            and count(distinct ${runSteps.stepNumber}) = count(*)
            and max(${runSteps.stepNumber}) - min(${runSteps.stepNumber}) + 1 = count(*)
            and min(${runSteps.stepNumber}) in (0, 1)
            and count(${stepValue}) = count(*)
            then sum(${stepValue}) end
        from ${runSteps} where ${runSteps.runId} = ${runs.id} and ${runSteps.agentId} = ${runs.agentId}
    )`
    return sql<number>`sum(case when ${runs.stepCount} > 0 and ${total} = ${measuredTotal} then 1 else 0 end)`
}

const measuredStepTokens = sql`case when ${runSteps.inputTokens} >= 0 and ${runSteps.outputTokens} >= 0
    and ${runSteps.totalTokens} = ${runSteps.inputTokens} + ${runSteps.outputTokens} then ${runSteps.totalTokens} end`
const measuredStepCost = sql`case when ${runSteps.costMicros} >= 0 then ${runSteps.costMicros} end`

const DATASETS: Record<StatsDataset, DatasetDef> = {
    runs: {
        table: runs,
        agentId: runs.agentId,
        timeColumn: runs.startedAt,
        metrics: {
            count: sql<number>`count(*)`,
            totalTokens: sql<number>`coalesce(sum(${runs.totalTokens}), 0)`,
            inputTokens: sql<number>`coalesce(sum(${runs.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${runs.outputTokens}), 0)`,
            cachedInputTokens: sql<number>`coalesce(sum(${runs.cachedInputTokens}), 0)`,
            reasoningTokens: sql<number>`coalesce(sum(${runs.reasoningTokens}), 0)`,
            cost: sql<number>`coalesce(sum(${runs.costMicros}), 0)`,
            avgDurationMs: runsDurationMs,
            errorCount: sql<number>`coalesce(sum(case when ${runs.status} = 'error' then 1 else 0 end), 0)`,
            errorRate: sql<number>`coalesce(avg(case when ${runs.status} = 'error' then 1.0 else 0.0 end), 0)`,
            recordedTokenRuns: recordedRuns(runs.totalTokens, measuredStepTokens),
            recordedCostRuns: recordedRuns(runs.costMicros, measuredStepCost),
        },
        groups: {
            model: sql<string | null>`${runs.model}`,
            status: sql<string | null>`${runs.status}`,
            triggerSource: sql<string | null>`${runs.triggerSource}`,
        },
        extraConditions: {
            avgDurationMs: and(
                isNotNull(runs.finishedAt),
                sql`julianday(${runs.finishedAt}) >= julianday(${runs.startedAt})`,
                sql`coalesce(${runs.error}, '') <> ${INTERRUPTED_RUN_ERROR}`
            )!,
        },
    },
    runSteps: {
        table: runSteps,
        agentId: runSteps.agentId,
        timeColumn: runSteps.createdAt,
        metrics: {
            count: sql<number>`count(*)`,
            totalTokens: sql<number>`coalesce(sum(${runSteps.totalTokens}), 0)`,
            inputTokens: sql<number>`coalesce(sum(${runSteps.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${runSteps.outputTokens}), 0)`,
            avgDurationMs: sql<number>`coalesce(avg(${runSteps.durationMs}), 0)`,
        },
        groups: {
            model: sql<string | null>`${runSteps.model}`,
            finishReason: sql<string | null>`${runSteps.finishReason}`,
            stepNumber: sql<string | null>`cast(${runSteps.stepNumber} as text)`,
        },
    },
    toolCalls: {
        table: toolCalls,
        agentId: toolCalls.agentId,
        timeColumn: toolCalls.createdAt,
        metrics: {
            count: sql<number>`count(*)`,
            errorCount: sql<number>`coalesce(sum(${toolCalls.isError}), 0)`,
            errorRate: sql<number>`coalesce(avg(${toolCalls.isError} * 1.0), 0)`,
            avgDurationMs: sql<number>`coalesce(avg(${toolCalls.durationMs}), 0)`,
        },
        groups: {
            toolName: sql<string | null>`${toolCalls.toolName}`,
        },
    },
    sessions: {
        table: sessions,
        agentId: sessions.agentId,
        timeColumn: sessions.createdAt,
        metrics: {
            count: sql<number>`count(*)`,
        },
        groups: {
            source: sql<string | null>`${sessions.source}`,
            status: sql<string | null>`${sessions.status}`,
        },
    },
}

export type StatsRepoQuery = {
    dataset: StatsDataset
    metric: StatsMetric
    groupBy: StatsGroupBy
    sinceIso: string | null
    // Return every group inside the selected window when the consumer totals across tool names.
    allGroupsThrough?: string
    bucket: 'hour' | 'day'
    status?: StatsRunStatusFilter
}

export async function aggregateStats(agentId: string, query: StatsRepoQuery): Promise<StatsPoint[]> {
    const def = DATASETS[query.dataset]
    const metricSql = def.metrics[query.metric]
    if (!metricSql) throw new Error(`unsupported metric ${query.metric} for dataset ${query.dataset}`)
    const groupSql = query.groupBy === 'none' ? null : def.groups[query.groupBy]
    if (query.groupBy !== 'none' && !groupSql) throw new Error(`unsupported groupBy ${query.groupBy} for dataset ${query.dataset}`)

    const bucket =
        query.bucket === 'hour'
            ? sql<string>`substr(${def.timeColumn}, 1, 13) || ':00'`
            : sql<string>`substr(${def.timeColumn}, 1, 10)`

    const conditions: SQL[] = [eq(def.agentId, agentId)]
    if (query.sinceIso) conditions.push(gte(def.timeColumn, query.sinceIso))
    if (query.allGroupsThrough) conditions.push(lte(def.timeColumn, query.allGroupsThrough))
    if (query.dataset === 'runs' && query.status && query.status !== 'all') conditions.push(eq(runs.status, query.status))
    const extra = def.extraConditions?.[query.metric]
    if (extra) conditions.push(extra)

    const { db } = await getSystemDb(agentId)
    const selection = {
        bucket,
        group: groupSql ?? sql<string | null>`null`,
        value: metricSql,
        count: sql<number>`count(*)`,
    }
    const base = db.select(selection).from(def.table).where(and(...conditions))
    const grouped = groupSql ? base.groupBy(bucket, groupSql) : base.groupBy(bucket)
    const ordered = grouped.orderBy(asc(bucket))
    return query.allGroupsThrough ? ordered : ordered.limit(5000)
}
