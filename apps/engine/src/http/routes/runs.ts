import { Hono } from 'hono'
import { z } from 'zod'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { listRunCompletions } from '../../db/completed-runs.js'
import { aggregateUsageByDay, getRun, listRunsByAgent } from '../../db/repos/runs.js'
import { listRunSteps, listToolCalls } from '../../db/repos/telemetry.js'
import { collectAssistantText } from '../../db/repos/messages.js'
import { resumeStreamResponse } from '../../runtime/stream.js'
import { cancelOwnedRun } from '../../runtime/cancel-run.js'
import { desktopApp } from '../../desktop/policy.js'
import { abortSubRun } from '../../tools/builtin/sub-run-watch.js'
import { getDesktopForemanQueuedUserMessageId } from '../../db/repos/desktop-queued-turns.js'

const USAGE_RANGE_MS: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
}

export const usageRoutes = new Hono()

usageRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    const range = c.req.query('range') ?? '7d'
    const ms = USAGE_RANGE_MS[range]
    const sinceIso = range === 'all' ? null : ms ? new Date(Date.now() - ms).toISOString() : new Date(Date.now() - USAGE_RANGE_MS['7d']).toISOString()
    return c.json({ buckets: await aggregateUsageByDay(agentId, sinceIso) })
})

export const runRoutes = new Hono()

runRoutes.post('/:rid/cancel', async c => {
    const agentId = c.req.param('id')!
    const rid = c.req.param('rid')!
    const run = await getRun(agentId, rid)
    if (!run || run.agentId !== agentId) return c.json({ error: 'run not found' }, 404)
    const result = await cancelOwnedRun(run)
    if (result.state === 'waiting') {
        return c.json({ error: 'This reply has not finished stopping. Wait a moment and try Stop again.' }, 503)
    }
    if (result.state === 'finished') {
        return c.json({ error: 'This reply already finished.' }, 409)
    }
    return c.json({ ok: true, aborted: result.aborted })
})

runRoutes.post('/:rid/tasks/:taskId/cancel', async c => {
    const agentId = c.req.param('id')!
    const rid = c.req.param('rid')!
    const run = await getRun(agentId, rid)
    if (!run || run.agentId !== agentId) return c.json({ error: 'run not found' }, 404)
    return c.json({ ok: true, aborted: abortSubRun(c.req.param('taskId')!) })
})

runRoutes.get('/:rid/stream', async c => {
    const agentId = c.req.param('id')!
    const rid = c.req.param('rid')!
    const run = await getRun(agentId, rid)
    if (!run || run.agentId !== agentId) return c.body(null, 204)
    return resumeStreamResponse(rid)
})

runRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    const limitParam = Number(c.req.query('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50
    const sessionId = c.req.query('session') || undefined
    const status = c.req.query('status') || undefined
    return c.json({ runs: await listRunsByAgent(agentId, { limit, sessionId, status }) })
})

// The desktop completion store reads through this bounded route: terminal identity and time order
// the rows, and `before` is the same (completed_at, id) cursor the desktop pagination uses.
runRoutes.get('/completions', async c => {
    const agentId = c.req.param('id')!
    const limitParam = Number(c.req.query('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 200) : 50
    const beforeParam = c.req.query('before')
    const idsParam = c.req.query('ids')
    let before: { completedAt: string; id: string; inclusiveId?: boolean } | undefined
    let ids: string[] | undefined
    try {
        if (beforeParam) before = z.object({ completedAt: z.string().datetime(), id: z.string().min(1).max(200), inclusiveId: z.boolean().optional() }).strict().parse(JSON.parse(beforeParam))
        if (idsParam) ids = z.array(z.string().min(1).max(200)).min(1).max(100).parse(JSON.parse(idsParam))
        if (before && ids) throw new Error('Choose one completion filter')
    } catch { return c.json({ error: 'Invalid completion cursor or IDs' }, 400) }
    return c.json({ completions: await listRunCompletions(agentId, { limit: ids?.length ?? limit, before, ids }) })
})

runRoutes.get('/:rid/steps', async c => {
    const agentId = c.req.param('id')!
    const rid = c.req.param('rid')!
    const run = await getRun(agentId, rid)
    if (!run || run.agentId !== agentId) return c.json({ error: 'run not found' }, 404)
    return c.json({ steps: await listRunSteps(agentId, rid) })
})

runRoutes.get('/:rid/tools', async c => {
    const agentId = c.req.param('id')!
    const rid = c.req.param('rid')!
    const run = await getRun(agentId, rid)
    if (!run || run.agentId !== agentId) return c.json({ error: 'run not found' }, 404)
    return c.json({ tools: await listToolCalls(agentId, rid) })
})

runRoutes.get('/:rid', async c => {
    const agentId = c.req.param('id')!
    const rid = c.req.param('rid')
    const run = await getRun(agentId, rid)
    if (!run || run.agentId !== agentId) return c.json({ error: 'run not found' }, 404)
    const output = await collectAssistantText(agentId, run.sessionId, run.startedAt, run.finishedAt)
    const queuedUserMessageId = desktopApp() && agentId === FOREMAN_AGENT_ID
        ? await getDesktopForemanQueuedUserMessageId(run.id, run.sessionId)
        : null
    return c.json({ ...run, output, ...(queuedUserMessageId ? { queuedUserMessageId } : {}) })
})
