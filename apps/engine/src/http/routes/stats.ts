import { Hono } from 'hono'
import { isValidStatsCombo, statsQuerySchema } from '@rerun/contracts'
import { agentExists } from '../../agents/loader.js'
import { aggregateStats } from '../../db/repos/stats.js'
import { desktopApp } from '../../desktop/policy.js'
import { notFound } from '../../lib/errors.js'

const RANGE_MS: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
}

export const statsRoutes = new Hono()

statsRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    const desktop = desktopApp()
    if (desktop && !agentExists(agentId)) throw notFound('agent')
    const parsed = statsQuerySchema.safeParse({
        dataset: c.req.query('dataset'),
        metric: c.req.query('metric'),
        groupBy: c.req.query('groupBy'),
        range: c.req.query('range'),
        status: c.req.query('status'),
    })
    if (!parsed.success || !isValidStatsCombo(parsed.data.dataset, parsed.data.metric, parsed.data.groupBy)) {
        return c.json({ error: 'invalid stats query' }, 400)
    }
    const { dataset, metric, groupBy, range, status } = parsed.data
    const now = Date.now()
    const sinceIso = range === 'all' ? null : new Date(now - RANGE_MS[range]).toISOString()
    const completeToolChart = desktop && range !== 'all' && dataset === 'toolCalls' && groupBy === 'toolName' && (metric === 'count' || metric === 'errorCount')
    const bucket = range === '24h' ? 'hour' : 'day'
    const points = await aggregateStats(agentId, {
        dataset,
        metric,
        groupBy,
        sinceIso,
        allGroupsThrough: completeToolChart ? new Date(now).toISOString() : undefined,
        bucket,
        status: dataset === 'runs' ? status : undefined,
    })
    return c.json({ points })
})
