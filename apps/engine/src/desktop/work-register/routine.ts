import { Hono } from 'hono'
import { z } from 'zod'
import { DESKTOP_WORK_ROUTINE_INSTRUCTION, DESKTOP_WORK_ROUTINE_NAME, DESKTOP_WORK_ROUTINE_SLUG, FOREMAN_AGENT_ID } from '@rerun/contracts'
import { consumeDesktopSchedule, readSchedule, scheduleExists, setScheduleEnabled, updateScheduleAt, writeSchedule, type Schedule } from '../../schedules/loader.js'
import { isDue, isValidCron, nextRunAt } from '../../schedules/cron.js'
import { ScheduleTimingError } from '../../schedules/next-run.js'
import { nowIso } from '../../lib/ids.js'
import { logger } from '../../lib/logger.js'
import { desktopRoutineGuard, desktopRoutineGuardResponse } from '../routine-guards.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { desktopApp } from '../policy.js'

/**
 * The Chief of Staff's one routine, "Coordinate the team". It is an ordinary schedule file of the
 * foreman agent, so the engine's own scheduler tick finds it due, with the same cron, the same
 * at-most-once occurrence and the same workspace limits as every coworker routine. What differs is
 * the run: the Chief of Staff works in conversations the app starts, so a due firing is handed to the
 * app, which opens a Chief of Staff conversation for it. No second scheduler exists.
 */

export type DesktopForemanRoutineFiring = { slug: string; occurrence: string; firedAt: string }
let announce: ((firing: DesktopForemanRoutineFiring) => Promise<void>) | undefined
export function configureDesktopForemanRoutine(next: typeof announce) { announce = next }

const firing = new Set<string>()

/** Called by the scheduler's tick for a due schedule of the foreman agent. Never throws. */
export async function fireDesktopForemanRoutine(schedule: Schedule, assertActive: () => void, now = () => new Date()): Promise<void> {
    if (firing.has(schedule.slug)) return
    firing.add(schedule.slug)
    try {
        assertActive(); assertDesktopRunAdmission()
        const current = await readSchedule(FOREMAN_AGENT_ID, schedule.slug)
        assertActive()
        if (!isDue(current, now())) return
        const firedAt = nowIso()
        // Consumed before the app is asked, as every routine occurrence is: a crash costs this
        // occurrence rather than running it twice. Only the one routine the app offers is run.
        await consumeDesktopSchedule(FOREMAN_AGENT_ID, current, firedAt)
        assertActive()
        if (current.slug !== DESKTOP_WORK_ROUTINE_SLUG) { logger.warn({ schedule: current.slug }, 'Chief of Staff schedule skipped: only Coordinate the team runs'); return }
        if (!announce) throw new Error('The app is not listening for Chief of Staff routines.')
        await announce({ slug: current.slug, occurrence: `${current.slug}:${firedAt}`, firedAt })
        logger.info({ schedule: current.slug }, 'Chief of Staff routine handed to the app')
    } catch (error) {
        logger.error({ schedule: schedule.slug, err: String(error) }, 'Chief of Staff routine could not start')
    } finally { firing.delete(schedule.slug) }
}

const saveSchema = z.strictObject({ enabled: z.boolean(), cron: z.string().min(1).max(120), timezone: z.string().min(1).max(80) })
const view = (schedule: Schedule | null) => schedule
    ? { enabled: schedule.enabled, cron: schedule.cron, timezone: schedule.timezone, lastRunAt: schedule.lastRunAt, nextRunAt: nextRunAt(schedule, new Date()) }
    : null

/** Read and save the timing of "Coordinate the team". The app keeps the scope and summary choice. */
export function createDesktopForemanRoutineRouter() {
    const routes = new Hono()
    const read = async () => scheduleExists(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG) ? await readSchedule(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG) : null
    routes.get('/', async c => {
        if (!desktopApp()) return c.notFound()
        return c.json({ schedule: view(await read()) }, 200, { 'cache-control': 'no-store' })
    })
    routes.put('/', async c => {
        if (!desktopApp()) return c.notFound()
        assertDesktopRunAdmission()
        const input = saveSchema.safeParse(await c.req.json().catch(() => null))
        if (!input.success || !isValidCron(input.data.cron)) return c.json({ error: 'Choose days and times for the routine.' }, 400)
        try { new Intl.DateTimeFormat('en', { timeZone: input.data.timezone }) } catch { return c.json({ error: 'Invalid timezone' }, 400) }
        const before = await read()
        const after = { enabled: input.data.enabled, cron: input.data.cron, timezone: input.data.timezone }
        const refusal = await desktopRoutineGuard(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG, before, after)
        if (refusal) return desktopRoutineGuardResponse(c, refusal)
        try {
            if (!before) await writeSchedule(FOREMAN_AGENT_ID, { name: DESKTOP_WORK_ROUTINE_NAME, description: 'The Chief of Staff reads the work register, asks coworkers for status and assigns next steps inside your agreed scope.', body: DESKTOP_WORK_ROUTINE_INSTRUCTION, ...after })
            else await updateScheduleAt(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG, { cron: after.cron, timezone: after.timezone, body: DESKTOP_WORK_ROUTINE_INSTRUCTION, runAt: null, ...(after.enabled ? {} : { enabled: false }) })
            // Switching on counts from now: times that passed while it was off are not run late.
            if (after.enabled && !before?.enabled) await setScheduleEnabled(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG, true, nowIso())
        } catch (error) {
            if (error instanceof ScheduleTimingError) return c.json({ error: error.message }, 400)
            throw error
        }
        return c.json({ schedule: view(await read()) }, 200, { 'cache-control': 'no-store' })
    })
    return routes
}
