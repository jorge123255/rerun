import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ rows: new Map<string, unknown>(), schedule: {} as Record<string, unknown>, writes: 0, runs: 0, loseAck: false }))
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
const call = (value: unknown, operation = 'mutate') => createDesktopWorkspaceRoutineRouter().request('/engine-a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input: value }) })
afterEach(() => vi.unstubAllEnvs())
beforeEach(() => { vi.stubEnv('RERUN_DESKTOP_APP', '1'); state.rows.clear(); state.writes = 0; state.runs = 0; state.loseAck = false; state.schedule = { slug: 'daily', name: 'Daily', description: '', enabled: true, cron: '0 8 * * *', runAt: null, timezone: 'UTC', lastRunAt: null, connectionId: null, provider: null, model: null, body: 'Work', createdAt: '2026-11-01T00:00:00.000Z' } })
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
