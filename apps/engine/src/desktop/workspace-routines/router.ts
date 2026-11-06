import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { desktopWorkspaceRoutineMutationSchema, type DesktopWorkspaceRoutineMutation } from '@rerun/contracts'
import { dataDir } from '../../config/paths.js'
import { HttpError } from '../../lib/errors.js'
import { withKeyedLock } from '../../lib/lock.js'
import { readOwnJson, replaceOwnJson } from '../templates/store.js'
import { desktopScheduleFiles } from '../schedule-tools/files.js'
import { desktopScheduleDefinitionRevision } from '../schedule-tools/revision.js'
import type { DesktopScheduleDefinition } from '../schedule-tools/types.js'
import { authorizeDesktopSchedule } from '../schedule-binding.js'
import { fireSchedule } from '../../runtime/scheduler.js'
import { isValidCron } from '../../schedules/cron.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { desktopApp } from '../policy.js'
import { desktopBrainRequestBody } from '../brain-pages-router.js'

const directory = () => join(dataDir(), 'desktop-workspace-routine-requests')
export async function initializeDesktopWorkspaceRoutineRequests() { await mkdir(directory(), { recursive: true, mode: 0o700 }) }
const fingerprintOf = (input: DesktopWorkspaceRoutineMutation) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
type Saved = { fingerprint: string; engineAgentId: string; input: DesktopWorkspaceRoutineMutation; before: DesktopScheduleDefinition; desired: DesktopScheduleDefinition; result?: { schedule: DesktopScheduleDefinition; revision: string; run?: { runId: string; sessionId: string } } }
const savedSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), engineAgentId: z.string(), input: desktopWorkspaceRoutineMutationSchema, before: z.object({}).passthrough(), desired: z.object({}).passthrough(), result: z.object({ schedule: z.object({}).passthrough(), revision: z.string(), run: z.object({ runId: z.string(), sessionId: z.string() }).optional() }).optional() })

export function createDesktopWorkspaceRoutineRouter() {
    const router = new Hono()
    router.get('/:id', async c => {
        if (!desktopApp()) throw new HttpError(404, 'Not found')
        const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(c.req.param('id'))
        const schedules = await desktopScheduleFiles().list(id)
        return c.json({ schedules: schedules.map(schedule => ({ ...schedule, revision: desktopScheduleDefinitionRevision(schedule) })) })
    })
    router.post('/:id', async c => {
        if (!desktopApp()) throw new HttpError(404, 'Not found')
        const engineAgentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(c.req.param('id'))
        const body = z.object({ operation: z.enum(['read', 'mutate']), input: desktopWorkspaceRoutineMutationSchema }).strict().parse(await desktopBrainRequestBody(c.req.raw))
        if (body.operation === 'mutate') assertDesktopRunAdmission()
        if (body.input.action === 'edit') {
            const fields = body.input.input
            if (fields.cron && !isValidCron(fields.cron)) throw new HttpError(400, 'Invalid cron expression')
            try { new Intl.DateTimeFormat('en', { timeZone: fields.timezone }) } catch { throw new HttpError(400, 'Invalid timezone') }
        }
        const input = body.input, fingerprint = fingerprintOf(input), signal = c.req.raw.signal
        const check = async () => { if (body.operation === 'mutate') assertDesktopRunAdmission(); signal.throwIfAborted(); await authorizeDesktopSchedule(engineAgentId); signal.throwIfAborted() }
        await check()
        return withKeyedLock(`workspace-routine-request:${input.requestId}`, async () => {
            const name = `${input.requestId}.json`
            const raw = await readOwnJson(directory(), name)
            const saved = raw ? savedSchema.parse(raw) as unknown as Saved : null
            if (saved && (saved.fingerprint !== fingerprint || saved.engineAgentId !== engineAgentId)) throw new HttpError(409, 'Routine request identity changed')
            if (saved?.result) { await check(); return c.json({ fingerprint, result: saved.result }) }
            if (body.operation === 'read') return c.json({ fingerprint, result: null, reserved: saved !== null })
            const files = desktopScheduleFiles(), current = await files.read(engineAgentId, input.slug)
            if (!current) throw new HttpError(404, 'Routine not found')
            const old = saved?.before ?? current
            if (!saved && desktopScheduleDefinitionRevision(current) !== input.expectedRevision) throw new HttpError(409, 'Routine changed; refresh before saving')
            let desired = saved?.desired ?? { ...current }
            if (!saved) {
                if (input.action === 'rename') desired = { ...current, name: input.name }
                else if (input.action === 'toggle') desired = { ...current, enabled: input.enabled }
                else if (input.action === 'edit') desired = { ...current, ...input.input }
                await check()
                await replaceOwnJson(directory(), name, { fingerprint, engineAgentId, input, before: old, desired })
            }
            await check()
            let schedule = current, run: { runId: string; sessionId: string } | undefined
            if (input.action === 'run') {
                if (desktopScheduleDefinitionRevision(current) !== desktopScheduleDefinitionRevision(old)) throw new HttpError(409, 'Routine changed; original run outcome must be reviewed')
                // Scheduler's durable manualId owns the occurrence through lost acknowledgements.
                run = await fireSchedule(engineAgentId, current, { markFired: false, ignoreBudgetLatch: true, manualId: input.requestId })
            } else if (desktopScheduleDefinitionRevision(current) !== desktopScheduleDefinitionRevision(desired)) {
                if (desktopScheduleDefinitionRevision(current) !== desktopScheduleDefinitionRevision(old)) throw new HttpError(409, 'Routine changed; original change is uncertain')
                schedule = (await files.replace(engineAgentId, input.slug, old, desired, check))!
            }
            const result = { schedule, revision: desktopScheduleDefinitionRevision(schedule), ...(run ? { run } : {}) }
            await replaceOwnJson(directory(), name, { fingerprint, engineAgentId, input, before: old, desired, result })
            await check()
            return c.json({ fingerprint, result })
        })
    })
    return router
}
