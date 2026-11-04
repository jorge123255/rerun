import { statsPointSchema } from '@rerun/contracts'
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
