import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-foreman-routine-'))
process.env.RERUN_API_KEY = ''
vi.mock('../../runtime/notify.js', async importOriginal => ({ ...(await importOriginal<typeof import('../../runtime/notify.js')>()), sendNotification: async () => ({ delivered: true }) }))
vi.mock('../policy.js', async importOriginal => ({ ...(await importOriginal<typeof import('../policy.js')>()), desktopApp: () => true }))
vi.mock('../workspace-admission.js', () => ({ assertDesktopRunAdmission: () => 1 }))
vi.mock('../routine-guards.js', async importOriginal => ({ ...(await importOriginal<typeof import('../routine-guards.js')>()), listEnabledDesktopRoutines: async () => [] }))

const { beforeEach, expect, test } = await import('vitest')
const { rm } = await import('node:fs/promises')
const { DESKTOP_WORK_ROUTINE_SLUG, DESKTOP_WORK_ROUTINE_INSTRUCTION, FOREMAN_AGENT_ID } = await import('@rerun/contracts')
const { schedulesDir } = await import('../../config/paths.js')
const { readSchedule, writeSchedule, updateScheduleAt } = await import('../../schedules/loader.js')
const { configureDesktopForemanRoutine, createDesktopForemanRoutineRouter, fireDesktopForemanRoutine } = await import('./routine.js')

const announced: unknown[] = []
beforeEach(async () => {
    announced.length = 0
    configureDesktopForemanRoutine(async firing => { announced.push(firing) })
    await rm(schedulesDir(FOREMAN_AGENT_ID), { recursive: true, force: true })
})
const active = () => {}
const app = () => createDesktopForemanRoutineRouter()
const put = (body: unknown) => app().request('/', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('Coordinate the team is off until the person switches it on', async () => {
    expect(await (await app().request('/')).json()).toEqual({ schedule: null })
    const saved = await (await put({ enabled: false, cron: '0 9,15 * * 1-5', timezone: 'UTC' })).json()
    expect(saved.schedule).toMatchObject({ enabled: false, cron: '0 9,15 * * 1-5', nextRunAt: null })
    // The saved text is the routine's own instruction; nothing about the person's scope is kept in the engine.
    expect((await readSchedule(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG)).body).toBe(DESKTOP_WORK_ROUTINE_INSTRUCTION)
    const on = await (await put({ enabled: true, cron: '0 9,15 * * 1-5', timezone: 'UTC' })).json()
    expect(on.schedule.enabled).toBe(true)
    expect(on.schedule.nextRunAt).not.toBeNull()
})

test('the workspace limits apply to it like any routine: more often than every 15 minutes is refused', async () => {
    const refused = await put({ enabled: true, cron: '*/5 * * * *', timezone: 'UTC' })
    expect(refused.status).toBe(422)
    expect(await (await app().request('/')).json()).toEqual({ schedule: null })
})

test('the scheduler\'s tick hands a due firing to the app once, and consumes the occurrence first', async () => {
    await writeSchedule(FOREMAN_AGENT_ID, { name: 'Coordinate the team', body: DESKTOP_WORK_ROUTINE_INSTRUCTION, cron: '0 9 * * *', timezone: 'UTC', enabled: true })
    await updateScheduleAt(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG, {})
    const schedule = await readSchedule(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG)
    // Pretend it was last run two days ago: the next 9:00 has passed.
    const { setScheduleEnabled } = await import('../../schedules/loader.js')
    await setScheduleEnabled(FOREMAN_AGENT_ID, schedule.slug, true, new Date(Date.now() - 2 * 86_400_000).toISOString())
    const due = await readSchedule(FOREMAN_AGENT_ID, schedule.slug)
    await Promise.all([fireDesktopForemanRoutine(due, active), fireDesktopForemanRoutine(due, active)])
    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ slug: DESKTOP_WORK_ROUTINE_SLUG, occurrence: expect.stringMatching(/^coordinate-the-team:/) })
    // Consumed: the same firing is not due again.
    await fireDesktopForemanRoutine(await readSchedule(FOREMAN_AGENT_ID, schedule.slug), active)
    expect(announced).toHaveLength(1)
})

test('a switched-off routine, or one with nobody listening, starts nothing and never throws', async () => {
    await writeSchedule(FOREMAN_AGENT_ID, { name: 'Coordinate the team', body: DESKTOP_WORK_ROUTINE_INSTRUCTION, cron: '0 9 * * *', timezone: 'UTC', enabled: false })
    const { setScheduleEnabled } = await import('../../schedules/loader.js')
    await setScheduleEnabled(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG, false, new Date(Date.now() - 2 * 86_400_000).toISOString())
    await fireDesktopForemanRoutine(await readSchedule(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG), active)
    expect(announced).toEqual([])
    configureDesktopForemanRoutine(undefined)
    await setScheduleEnabled(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG, true, new Date(Date.now() - 2 * 86_400_000).toISOString())
    await expect(fireDesktopForemanRoutine(await readSchedule(FOREMAN_AGENT_ID, DESKTOP_WORK_ROUTINE_SLUG), active)).resolves.toBeUndefined()
})
