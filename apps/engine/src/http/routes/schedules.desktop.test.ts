import { Hono } from 'hono'
import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ desktop: false, update: vi.fn(), authorize: vi.fn(), describe: vi.fn(), fire: vi.fn() }))
vi.mock('../../desktop/policy.js', () => ({ desktopApp: () => state.desktop }))
vi.mock('../../desktop/schedule-binding.js', () => ({ authorizeDesktopSchedule: state.authorize }))
vi.mock('../../desktop/schedule-description.js', async importOriginal => ({ ...await importOriginal<typeof import('../../desktop/schedule-description.js')>(), describeDesktopSchedule: state.describe }))
vi.mock('../../schedules/loader.js', () => ({
    scheduleExists: () => true, readSchedule: async () => ({ slug: 'daily', cron: '0 9 * * *', runAt: null }), updateScheduleAt: state.update,
    deleteSchedule: vi.fn(), listSchedules: vi.fn(), writeSchedule: vi.fn(),
}))
vi.mock('../../runtime/scheduler.js', () => ({ fireSchedule: state.fire }))
vi.mock('../../agents/registry.js', () => ({ getAgent: vi.fn() }))
import { scheduleRoutes } from './schedules.js'
const app = new Hono().route('/agents/:id/schedules', scheduleRoutes)
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
    state.describe.mockResolvedValue({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5' } })

    const response = await describeRequest()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok', value: { mode: 'cron', cron: '0 8 * * 1-5' } })
    expect(state.describe).toHaveBeenCalledWith('owner', description, expect.any(AbortSignal))
    expect(state.fire).not.toHaveBeenCalled()
    expect(state.update).not.toHaveBeenCalled()
})

test('returns invalid parser output without creating or firing a routine', async () => {
    state.describe.mockResolvedValue({ status: 'invalid', message: 'The model returned an invalid schedule.' })

    const response = await describeRequest()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'invalid' })
    expect(state.fire).not.toHaveBeenCalled()
    expect(state.update).not.toHaveBeenCalled()
})

test('propagates workspace denial without a fallback parse or routine mutation', async () => {
    state.describe.mockRejectedValue(new Error('workspace denied'))

    await expect(describeRequest()).rejects.toThrow('workspace denied')
    expect(state.fire).not.toHaveBeenCalled()
    expect(state.update).not.toHaveBeenCalled()
})
