import { desktopApp } from '../../desktop/policy.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { providerSchema } from '@rerun/contracts'
import { deleteSchedule, listSchedules, readSchedule, scheduleExists, updateScheduleAt, writeSchedule } from '../../schedules/loader.js'
import { ScheduleTimingError } from '../../schedules/next-run.js'
import { isValidCron } from '../../schedules/cron.js'
import { fireSchedule } from '../../runtime/scheduler.js'
import { getAgent } from '../../agents/registry.js'
import { hasPendingSetup } from '../../agents/setup.js'
import { setupPending } from '../../lib/errors.js'
import { authorizeDesktopSchedule } from '../../desktop/schedule-binding.js'
import { describeDesktopSchedule, desktopScheduleDescriptionInputSchema } from '../../desktop/schedule-description.js'

export const scheduleRoutes = new Hono()
const authorize = async (agentId: string) => { if (desktopApp()) await authorizeDesktopSchedule(agentId) }

const createSchema = z
    .object({
        name: z.string().min(1),
        description: z.string().default(''),
        body: z.string().min(1),
        cron: z.string().optional(),
        runAt: z.string().optional(),
        timezone: z.string().optional(),
        enabled: z.boolean().optional(),
        connectionId: z.string().nullable().optional(),
        // Null on both means "whatever the agent runs", which is itself the box default when the
        // agent picked nothing. A routine only freezes a pair when someone chose one.
        provider: providerSchema.nullable().default(null),
        model: z.string().nullable().default(null),
    })
    .refine(d => Boolean(d.cron) !== Boolean(d.runAt), { message: 'Provide exactly one of cron or runAt' })
    .refine(d => !d.cron || isValidCron(d.cron), { message: 'Invalid cron expression' })
    .refine(d => !d.runAt || !Number.isNaN(new Date(d.runAt).getTime()), { message: 'Invalid runAt timestamp' })

scheduleRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    await authorize(agentId)
    return c.json({ schedules: await listSchedules(agentId) })
})

scheduleRoutes.post('/', async c => {
    const agentId = c.req.param('id')!
    const body = createSchema.parse(await c.req.json())
    await authorize(agentId)
    try {
        const schedule = await writeSchedule(agentId, body)
        return c.json(schedule, 201)
    } catch (error) {
        if (error instanceof ScheduleTimingError) return c.json({ error: error.message }, 400)
        throw error
    }
})

scheduleRoutes.get('/:slug', async c => {
    const agentId = c.req.param('id')!
    const slug = c.req.param('slug')
    await authorize(agentId)
    if (!scheduleExists(agentId, slug)) return c.json({ error: 'schedule not found' }, 404)
    return c.json(await readSchedule(agentId, slug))
})

scheduleRoutes.patch('/:slug', async c => {
    const agentId = c.req.param('id')!
    const slug = c.req.param('slug')
    if (!scheduleExists(agentId, slug)) return c.json({ error: 'schedule not found' }, 404)
    const body = z
        .object({
            name: z.string().trim().min(1).max(120).optional(),
            description: z.string().optional(),
            body: z.string().optional(),
            cron: z.string().nullable().optional(),
            runAt: z.string().nullable().optional(),
            timezone: z.string().optional(),
            enabled: z.boolean().optional(),
            connectionId: z.string().nullable().optional(),
            provider: providerSchema.nullable().optional(),
            model: z.string().nullable().optional(),
        })
        .parse(await c.req.json())
    if (body.cron && !isValidCron(body.cron)) return c.json({ error: 'invalid cron expression' }, 400)
    if (body.runAt && Number.isNaN(new Date(body.runAt).getTime())) return c.json({ error: 'invalid runAt timestamp' }, 400)
    const before=await readSchedule(agentId,slug)
    const merged={...before,...body}
    if(desktopApp() && Boolean(merged.cron)===Boolean(merged.runAt))return c.json({error:'Provide exactly one of cron or runAt'},400)
    if(body.timezone) {try {new Intl.DateTimeFormat('en',{timeZone:body.timezone})}catch{return c.json({error:'Invalid timezone'},400)}}
    await authorize(agentId)
    try {
        const schedule = await updateScheduleAt(agentId, slug, body)
        return c.json(schedule)
    } catch (error) {
        if (error instanceof ScheduleTimingError) return c.json({ error: error.message }, 400)
        throw error
    }
})

scheduleRoutes.post('/describe', async c => {
    const agentId = c.req.param('id')!
    const input = desktopScheduleDescriptionInputSchema.parse(await c.req.json())
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20_000)])
    return c.json(await describeDesktopSchedule(agentId, input, signal))
})

scheduleRoutes.post('/:slug/run', async c => {
    const agentId = c.req.param('id')!
    const slug = c.req.param('slug')
    await authorize(agentId)
    if (!scheduleExists(agentId, slug)) return c.json({ error: 'schedule not found' }, 404)
    const schedule = await readSchedule(agentId, slug)
    // A schedule still paused for the install would start in a fresh session carrying the install
    // prompt and tools, and run a second install beside the real one. Skipping the setup switches
    // the schedules on, which lifts this.
    if (hasPendingSetup(await getAgent(agentId)) && !schedule.enabled) throw setupPending()
    // A manual run is a deliberate probe: it may clear the budget latch, or re-arm it and show the
    // failure in the UI.
    const { runId, sessionId } = await fireSchedule(agentId, schedule, { markFired: false, ignoreBudgetLatch: true, manualId:desktopApp() ? z.string().uuid().parse(c.req.header('x-desktop-schedule-request-id')) : undefined })
    return c.json({ runId, sessionId }, 202)
})

scheduleRoutes.delete('/:slug', async c => {
    const agentId = c.req.param('id')!
    const slug = c.req.param('slug')
    await authorize(agentId)
    if (!scheduleExists(agentId, slug)) return c.json({ error: 'schedule not found' }, 404)
    await deleteSchedule(agentId, slug)
    return c.json({ deleted: slug })
})
