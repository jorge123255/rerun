import { statsPointSchema, type StatsPoint } from '@rerun/contracts'
import type { TokenUsageDay } from '@rerun/ui/monitoring'
import { z } from 'zod'

export const MONITORING_RANGES = ['24h', '7d', '30d', '90d'] as const
export const monitoringRangeSchema = z.enum(MONITORING_RANGES)
export type MonitoringRange = z.infer<typeof monitoringRangeSchema>

export const desktopMonitoringSchema = z.object({
    agentId: z.string(),
    range: monitoringRangeSchema,
    runs: z.array(statsPointSchema),
    errorRate: z.array(statsPointSchema),
    runsByStatus: z.array(statsPointSchema),
    runsByModel: z.array(statsPointSchema),
    totalTokens: z.array(statsPointSchema).nullable(),
    cost: z.array(statsPointSchema).nullable(),
    avgDuration: z.array(statsPointSchema),
    toolCalls: z.array(statsPointSchema),
    toolErrors: z.array(statsPointSchema),
})
export type DesktopMonitoring = z.infer<typeof desktopMonitoringSchema>

export function dailyTokenUsage(points: StatsPoint[]): TokenUsageDay[] {
    const days = new Map<string, TokenUsageDay>()
    for (const point of points) {
        const key = point.bucket.slice(0, 10)
        const day = days.get(key) ?? { day: key, totalTokens: 0, runCount: 0 }
        day.totalTokens += point.value
        day.runCount += point.count
        days.set(key, day)
    }
    return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}
