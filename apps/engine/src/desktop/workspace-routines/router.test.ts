import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HttpError } from '../../lib/errors.js'
const state = vi.hoisted(() => ({ rows: new Map<string, unknown>(), schedule: {} as Record<string, unknown>, writes: 0, runs: 0, loseAck: false, resolveModel: vi.fn() }))
vi.mock('../../agents/registry.js', () => ({ getAgent: async (id: string) => ({ id }) }))
vi.mock('../schedule-model.js', () => ({ resolveDesktopScheduleModel: state.resolveModel }))
vi.mock('../templates/store.js', () => ({ readOwnJson: async (_dir: string, name: string) => state.rows.get(name) ?? null, replaceOwnJson: async (_dir: string, name: string, value: { result?: unknown }) => { if (value.result && state.loseAck) { state.loseAck = false; throw new Error('Lost ACK') }; state.rows.set(name, structuredClone(value)) } }))
vi.mock('../schedule-tools/files.js', () => ({ desktopScheduleFiles: () => ({ list: async () => [state.schedule], read: async () => structuredClone(state.schedule), replace: async (_owner: string, _slug: string, _before: unknown, next: Record<string, unknown>, admission: () => Promise<void>) => { await admission(); state.writes++; state.schedule = structuredClone(next); return structuredClone(next) } }) }))
vi.mock('../schedule-binding.js', () => ({ authorizeDesktopSchedule: async () => {} }))
vi.mock('../../runtime/scheduler.js', () => ({ fireSchedule: async () => { state.runs++; return { runId: `run-${state.runs}`, sessionId: `session-${state.runs}` } } }))
vi.mock('../workspace-admission.js', () => ({ assertDesktopRunAdmission: () => 0 }))
import { createDesktopWorkspaceRoutineRouter } from './router.js'
import { desktopScheduleDefinitionRevision } from '../schedule-tools/revision.js'
const id = '00000000-0000-4000-8000-000000000001'
const revision = () => desktopScheduleDefinitionRevision(state.schedule as never)
const input = (patch = {}) => ({ action: 'toggle', agentId: 'local-a', slug: 'daily', expectedRevision: revision(), requestId: id, enabled: false, ...patch })
function call(value: unknown, operation = 'mutate') {
    const router = createDesktopWorkspaceRoutineRouter()
    router.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError && error.status === 409 ? 409 : 500))
    return router.request('/engine-a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input: value }) })
}
afterEach(() => vi.unstubAllEnvs())
beforeEach(() => { vi.stubEnv('RERUN_DESKTOP_APP', '1'); state.rows.clear(); state.writes = 0; state.runs = 0; state.loseAck = false; state.schedule = { slug: 'daily', name: 'Daily', description: '', enabled: true, cron: '0 8 * * *', runAt: null, timezone: 'UTC', lastRunAt: null, connectionId: null, provider: null, model: null, body: 'Work', createdAt: '2026-11-01T00:00:00.000Z' } })
beforeEach(() => { state.resolveModel.mockReset() })
it('recovers a landed mutation after lost ACK without rewriting or using a new revision', async () => {
    const original = input(); state.loseAck = true
    expect((await call(original)).ok).toBe(false)
    expect(state.writes).toBe(1)
    expect((await call(original)).ok).toBe(true)
    expect(state.writes).toBe(1)
})
it('rejects changed payload under an existing exact request identity', async () => {
    const original = input(); expect((await call(original)).ok).toBe(true)
    expect((await call({ ...original, enabled: true })).ok).toBe(false)
    expect(state.writes).toBe(1)
})
it('replays one run identity but permits a later explicit run under a new request', async () => {
    const original = { action: 'run', agentId: 'local-a', slug: 'daily', expectedRevision: revision(), requestId: id }
    expect((await call(original)).ok).toBe(true)
    expect((await call(original)).ok).toBe(true)
    expect(state.runs).toBe(1)
    expect((await call({ ...original, requestId: '00000000-0000-4000-8000-000000000002' })).ok).toBe(true)
    expect(state.runs).toBe(2)
})
it('retains exact run/session identity in the receipt and refuses an old incomplete receipt without launching again', async () => {
    const original = { action: 'run', agentId: 'local-a', slug: 'daily', expectedRevision: revision(), requestId: id }
    const first = await call(original)
    expect(await first.json()).toMatchObject({ result: { run: { runId: 'run-1', sessionId: 'session-1' } } })
    const replay = await call(original, 'read')
    expect(await replay.json()).toMatchObject({ result: { run: { runId: 'run-1', sessionId: 'session-1' } } })
    const saved = state.rows.get(`${id}.json`) as { result: { run?: unknown } }
    delete saved.result.run
    expect((await call(original)).ok).toBe(false)
    expect(state.runs).toBe(1)
})

const pin = { connectionId: 'conn-b', provider: 'openai', model: 'gpt-exact' }
const edit = (fields = {}) => ({
    action: 'edit', agentId: 'local-a', slug: 'daily', expectedRevision: revision(), requestId: id,
    input: { name: 'Updated', description: '', body: 'Work', cron: '0 8 * * *', runAt: null, timezone: 'UTC', enabled: true, ...fields },
})

it('saves the exact model pair on the authorized coworker and replays a landed edit after a lost ACK', async () => {
    const request = edit({ modelOverride: pin })
    state.loseAck = true
    expect((await call(request)).status).toBe(500)
    expect(state.schedule).toMatchObject(pin)
    expect(state.schedule).not.toHaveProperty('modelOverride')
    expect(state.resolveModel).toHaveBeenCalledTimes(2)
    expect(state.resolveModel).toHaveBeenCalledWith({ id: 'engine-a' }, pin)
    state.resolveModel.mockRejectedValue(new HttpError(409, 'Model no longer available'))
    const replay = await call(request)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ result: { schedule: pin, revision: revision() } })
    expect(state.writes).toBe(1)
})

it('retains a saved pin when omitted and clears it only on explicit coworker default', async () => {
    Object.assign(state.schedule, pin)
    expect((await call(edit())).status).toBe(200)
    expect(state.schedule).toMatchObject(pin)
    const request = { ...edit({ modelOverride: null }), requestId: '00000000-0000-4000-8000-000000000002' }
    expect((await call(request)).status).toBe(200)
    expect(state.schedule).toMatchObject({ connectionId: null, provider: null, model: null })
    expect(state.resolveModel).not.toHaveBeenCalled()
})

it('refuses a model that becomes unavailable before the schedule is published', async () => {
    state.resolveModel.mockResolvedValueOnce(pin).mockRejectedValueOnce(new HttpError(409, 'Model no longer available'))
    const request = edit({ modelOverride: pin })
    expect((await call(request)).status).toBe(409)
    expect(state.writes).toBe(0)
    expect(state.schedule).toMatchObject({ connectionId: null, provider: null, model: null })
})
