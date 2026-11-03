import 'server-only'
import type { StatsGroupBy, StatsMetric, StatsPoint } from '@rerun/contracts'
import { getAgentStats } from '@/lib/engine/client'
import type { EngineConnection } from '@/lib/engine/types'
import { desktopMonitoringSchema, type DesktopMonitoring, type MonitoringRange } from '../monitoring'
import type { DesktopAgent } from './store'

const QUERIES: { key: 'runs' | 'errorRate' | 'runsByStatus' | 'runsByModel' | 'totalTokens' | 'recordedTokenRuns' | 'cost' | 'recordedCostRuns'; metric: StatsMetric; groupBy: StatsGroupBy }[] = [
    { key: 'runs', metric: 'count', groupBy: 'none' },
    { key: 'errorRate', metric: 'errorRate', groupBy: 'none' },
    { key: 'runsByStatus', metric: 'count', groupBy: 'status' },
    { key: 'runsByModel', metric: 'count', groupBy: 'model' },
    { key: 'totalTokens', metric: 'totalTokens', groupBy: 'none' },
    { key: 'recordedTokenRuns', metric: 'recordedTokenRuns', groupBy: 'none' },
    { key: 'cost', metric: 'cost', groupBy: 'none' },
    { key: 'recordedCostRuns', metric: 'recordedCostRuns', groupBy: 'none' },
]

function fullyRecorded(points: StatsPoint[]): boolean {
    return points.length > 0 && points.every(point => point.value === point.count)
}

export async function readDesktopMonitoring(engine: EngineConnection, agent: DesktopAgent, range: MonitoringRange): Promise<DesktopMonitoring> {
    const results = await Promise.all(
        QUERIES.map(query => getAgentStats(engine, agent.engineAgentId, { dataset: 'runs', metric: query.metric, groupBy: query.groupBy, range }))
    )
    const stats = Object.fromEntries(QUERIES.map((query, i) => [query.key, results[i]])) as Record<(typeof QUERIES)[number]['key'], StatsPoint[]>
    return desktopMonitoringSchema.parse({
        agentId: agent.id,
        range,
        runs: stats.runs,
        errorRate: stats.errorRate,
        runsByStatus: stats.runsByStatus,
        runsByModel: stats.runsByModel,
        totalTokens: fullyRecorded(stats.recordedTokenRuns) ? stats.totalTokens : null,
        cost: fullyRecorded(stats.recordedCostRuns) && stats.cost.reduce((sum, point) => sum + point.value, 0) > 0 ? stats.cost : null,
    })
}
