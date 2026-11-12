import { Hono } from 'hono'
import { HttpError } from '../../lib/errors.js'
import { beforeEach, expect, test, vi } from 'vitest'
import type { DesktopScheduleDefinition, DesktopScheduleFilePort } from '../../desktop/schedule-tools/types.js'
const state = vi.hoisted(() => ({
    desktop: false, update: vi.fn(), authorize: vi.fn(), describe: vi.fn(), fire: vi.fn(), legacyDelete: vi.fn(),
    files: null as DesktopScheduleFilePort | null,
}))
vi.mock('../../desktop/policy.js', () => ({ desktopApp: () => state.desktop }))
vi.mock('../../desktop/schedule-binding.js', () => ({ authorizeDesktopSchedule: state.authorize }))
vi.mock('../../desktop/schedule-description.js', async importOriginal => ({ ...await importOriginal<typeof import('../../desktop/schedule-description.js')>(), describeDesktopSchedule: state.describe }))
vi.mock('../../schedules/loader.js', () => ({
    scheduleExists: () => true, readSchedule: async () => ({ slug: 'daily', cron: '0 9 * * *', runAt: null }), updateScheduleAt: state.update,
    deleteSchedule: state.legacyDelete, listSchedules: vi.fn(), writeSchedule: vi.fn(),
}))
vi.mock('../../desktop/schedule-tools/files.js', async original => ({
    ...await original<typeof import('../../desktop/schedule-tools/files.js')>(),
    desktopScheduleFiles: () => state.files,
}))
vi.mock('../../runtime/scheduler.js', () => ({ fireSchedule: state.fire }))
vi.mock('../../agents/registry.js', () => ({ getAgent: vi.fn() }))
import { scheduleRoutes } from './schedules.js'
import { memoryScheduleFiles } from '../../desktop/schedule-tools/files.js'
import { desktopScheduleDefinitionRevision } from '../../desktop/schedule-tools/revision.js'
const app = new Hono().route('/agents/:id/schedules', scheduleRoutes)
app.onError((error, c) => error instanceof HttpError ? c.json({ error: error.message }, error.status as 403) : c.text('Internal error', 500))
const patch = (body: unknown) => app.request('/agents/owner/schedules/daily', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(() => { vi.clearAllMocks(); state.desktop = false; state.update.mockImplementation(async (_owner, _slug, body) => body); state.authorize.mockResolvedValue(undefined) })
test('preserves original hosted merged timing while desktop requires exactly one timing', async () => {
    expect((await patch({ runAt: '2030-01-01T09:00:00.000Z' })).status).toBe(200)
    expect(state.authorize).not.toHaveBeenCalled()
    state.update.mockClear(); state.desktop = true
    expect((await patch({ runAt: '2030-01-01T09:00:00.000Z' })).status).toBe(400)
    expect(state.update).not.toHaveBeenCalled()
    expect((await patch({ cron: null, runAt: '2030-01-01T09:00:00.000Z' })).status).toBe(200)
    expect(state.authorize).toHaveBeenCalledWith('owner')
})


const description = { description: 'weekdays at 8', nowIso: '2026-11-09T12:00:00-06:00', timezone: 'America/Chicago', connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' }
const describeRequest = () => app.request('/agents/owner/schedules/describe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(description),
})

test('forwards a bounded description to the local operation without creating or firing a routine', async () => {
    state.desktop = true
    state.describe.mockResolvedValue({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5' } })

    const response = await describeRequest()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5' } })
    expect(state.describe).toHaveBeenCalledWith('owner', description, expect.any(AbortSignal))
    expect(state.fire).not.toHaveBeenCalled()
    expect(state.update).not.toHaveBeenCalled()
})

test('returns invalid parser output without creating or firing a routine', async () => {
    state.desktop = true
    state.describe.mockResolvedValue({ status: 'invalid', message: 'The model returned an invalid schedule.' })

    const response = await describeRequest()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'invalid' })
    expect(state.fire).not.toHaveBeenCalled()
    expect(state.update).not.toHaveBeenCalled()
})

test('propagates workspace denial without a fallback parse or routine mutation', async () => {
    state.desktop = true
    state.describe.mockRejectedValue(new HttpError(403, 'workspace denied'))

    const response = await describeRequest()
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'workspace denied' })
    expect(state.fire).not.toHaveBeenCalled()
    expect(state.update).not.toHaveBeenCalled()
})

const daily: DesktopScheduleDefinition = {
    slug: 'daily', name: 'Daily', description: '', body: 'Read notes', enabled: true, cron: '0 9 * * *', runAt: null,
    timezone: 'UTC', lastRunAt: null, connectionId: null, provider: null, model: null, createdAt: '2026-11-01T00:00:00.000Z',
}
const remove = (record: DesktopScheduleDefinition) => app.request('/agents/owner/schedules/daily', {
    method: 'DELETE', headers: { 'x-desktop-schedule-revision': desktopScheduleDefinitionRevision(record) },
})

test('deletes only the reviewed definition and lets a retry acknowledge an absent task', async () => {
    state.desktop = true
    const files = memoryScheduleFiles()
    files.seed('owner', daily)
    files.seed('sibling', daily)
    state.files = files
    expect((await remove(daily)).status).toBe(200)
    expect(await files.read('owner', daily.slug)).toBeNull()
    expect(await files.read('sibling', daily.slug)).toEqual(daily)
    expect((await remove(daily)).status).toBe(200)
    const replacement = { ...daily, createdAt: '2026-11-02T00:00:00.000Z' }
    files.seed('owner', replacement)
    expect((await remove(daily)).status).toBe(412)
    expect(await files.read('owner', daily.slug)).toEqual(replacement)
    expect(state.legacyDelete).not.toHaveBeenCalled()
})

test('refuses a routine changed between the initial read and the deletion lock', async () => {
    state.desktop = true
    const files = memoryScheduleFiles()
    files.seed('owner', daily)
    const newer = { ...daily, name: 'Updated elsewhere' }
    state.files = { ...files, replace: async (...args) => {
        files.seed('owner', newer)
        return files.replace(...args)
    } }
    expect((await remove(daily)).status).toBe(412)
    expect(await files.read('owner', daily.slug)).toEqual(newer)
})

test('rechecks the schedules grant inside the deletion lock', async () => {
    state.desktop = true
    const files = memoryScheduleFiles()
    files.seed('owner', daily)
    state.files = files
    state.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new HttpError(403, 'Schedules disabled'))
    expect((await remove(daily)).status).toBe(403)
    expect(await files.read('owner', daily.slug)).toEqual(daily)
})
