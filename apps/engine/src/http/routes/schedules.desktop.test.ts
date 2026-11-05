import { Hono } from 'hono'
import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ desktop: false, update: vi.fn(), authorize: vi.fn() }))
vi.mock('../../desktop/policy.js', () => ({ desktopApp: () => state.desktop }))
vi.mock('../../desktop/schedule-binding.js', () => ({ authorizeDesktopSchedule: state.authorize }))
vi.mock('../../schedules/loader.js', () => ({
    scheduleExists: () => true, readSchedule: async () => ({ slug: 'daily', cron: '0 9 * * *', runAt: null }), updateScheduleAt: state.update,
    deleteSchedule: vi.fn(), listSchedules: vi.fn(), writeSchedule: vi.fn(),
}))
vi.mock('../../runtime/scheduler.js', () => ({ fireSchedule: vi.fn() }))
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
