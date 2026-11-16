import { createClient } from '@libsql/client'
import { vi } from 'vitest'

process.env.RERUN_LOG_LEVEL = 'fatal'

type Outcome = { kind: 'done' | 'error' | 'cancelled'; error?: string }
type Run = { finish: (outcome: Outcome) => void }

const state = vi.hoisted(() => ({
    client: null as unknown,
    files: {} as Record<string, Record<string, unknown>>,
    due: new Set<string>(),
    runs: [] as Run[],
    sent: [] as Array<Record<string, unknown> & { metadata?: Record<string, unknown> }>,
    notes: [] as Array<{ sessionId: string; content: unknown }>,
    sessions: 0,
    providerRefused: false,
    sessionFails: false,
    claim: true,
    agentEnabled: (() => true) as () => boolean,
    paused: new Set<string>(),
    authorize: (async () => {}) as () => Promise<void>,
    preset: null as (() => Promise<{ connectionId: string; model: string } | null>) | null,
}))

vi.mock('../db/systemDb.js', () => ({ getSystemDb: async () => ({ client: state.client }) }))
vi.mock('../desktop/policy.js', () => ({ desktopApp: () => true, assertDesktopProvider: () => { if (state.providerRefused) throw new Error('This connection is unavailable in the desktop preview.') } }))
vi.mock('../desktop/workspace-admission.js', () => ({ assertDesktopRunAdmission: () => 0 }))
vi.mock('./desktop-schedule-state.js', () => ({ replayDesktopSchedule: async () => null, claimDesktopSchedule: async () => state.claim, recordDesktopSchedule: async () => {}, finishDesktopSchedule: async () => {} }))
vi.mock('../agents/availability.js', () => ({
    automationModel: async () => ({ connectionId: 'mac-chatgpt', provider: 'codex', model: 'gpt-plan' }),
    resolveRunModel: async (_agent: unknown, override: { connectionId: string; provider: string; model: string }) => ({ connection: { id: override.connectionId, config: { name: 'ChatGPT' } }, provider: override.provider ?? 'openai', model: override.model }),
    isUsable: () => true,
}))
vi.mock('../agents/loader.js', () => ({ listAgentIdsOnDisk: async () => ['on'] }))
vi.mock('../agents/registry.js', () => ({ getAgent: async (id: string) => ({ id, config: { name: 'Mira', enabled: state.agentEnabled() }, resolved: { provider: 'codex', connection: undefined } }) }))
vi.mock('../db/repos/sessions.js', () => ({ createSession: async () => { if (state.sessionFails) throw new Error('database is locked'); return { id: `sess-${++state.sessions}` } } }))
vi.mock('../db/repos/messages.js', () => ({ appendMessage: async (_agentId: string, sessionId: string, message: { content: unknown }) => { state.notes.push({ sessionId, content: message.content }) } }))
vi.mock('../schedules/loader.js', () => ({
    readSchedule: async (_agentId: string, slug: string) => state.paused.has(slug) ? { ...state.files[slug], enabled: false } : state.files[slug],
    listSchedules: async () => Object.values(state.files),
    markFired: async () => {},
    scheduleExists: (_agentId: string, slug: string) => Boolean(state.files[slug]),
    setScheduleEnabled: async (_agentId: string, slug: string, enabled: boolean) => { state.files[slug] = { ...state.files[slug], enabled } },
    consumeDesktopSchedule: async (_agentId: string, current: { slug: string; runAt: string | null; enabled: boolean }, firedAt: string) => {
        state.due.delete(current.slug)
        return state.files[current.slug] = { ...current, lastRunAt: firedAt, enabled: current.runAt ? false : current.enabled }
    },
}))
vi.mock('../schedules/cron.js', () => ({ isDue: (schedule: { slug: string; enabled: boolean }) => schedule.enabled && state.due.has(schedule.slug) }))
vi.mock('../memory/maintenance.js', () => ({ sweepMemoriesIfDue: async () => {} }))
vi.mock('../brain/maintenance.js', () => ({ maintainBrainIfDue: async () => {} }))
vi.mock('../connections/codex-sweep.js', () => ({ sweepCodexHomesIfDue: async () => {} }))
vi.mock('./notify.js', () => ({ sendNotification: async (input: Record<string, unknown>) => { state.sent.push(input); return { delivered: true } } }))
vi.mock('./headless-run.js', () => ({
    startHeadlessRun: async () => {
        let finish!: (outcome: Outcome) => void
        const settled = new Promise<Outcome>(resolve => (finish = resolve))
        state.runs.push({ finish })
        return { runId: `run-${state.runs.length}`, settled }
    },
}))

const { afterEach, beforeEach, describe, expect, it } = await import('vitest')
const { ROUTINE_FAILURES_BEFORE_OFF } = await import('@rerun/contracts')
const { fireSchedule, startScheduler, configureDesktopSchedules } = await import('./scheduler.js')
const gate = await import('../desktop/usage-gate.js')
const health = await import('../desktop/routine-runs.js')
const { recordPlanLimits, forgetPlanLimits } = await import('../connections/plan-limits.js')
const { HttpError } = await import('../lib/errors.js')
type Schedule = import('../schedules/loader.js').Schedule

const START = new Date('2026-11-16T10:00:00.000Z')
const HOUR = 60 * 60_000
const clients: ReturnType<typeof createClient>[] = []

// Hourly, with half a saved model: the scheduler refuses it before any run exists.
const BROKEN = { connectionId: 'mac-chatgpt', provider: 'codex', model: null }
function schedule(slug: string, extra: Partial<Schedule> = {}): Schedule {
    const value = { slug, name: 'Daily digest', description: '', enabled: true, cron: '0 * * * *', runAt: null, timezone: null, lastRunAt: null, connectionId: null, provider: null, model: null, body: 'work', createdAt: '2026-01-01T00:00:00.000Z', ...extra } as Schedule
    state.files[slug] = value as unknown as Record<string, unknown>
    state.due.add(slug)
    return value
}
const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0) }
const tick = async (ms = 30_000) => { await vi.advanceTimersByTimeAsync(ms); await settle() }
const failures = async (slug: string) => (await health.readDesktopRoutineHealth('on', [{ slug, enabled: Boolean(state.files[slug]?.enabled) }])).get(slug)!.consecutiveFailures
const notices = () => state.sent.filter(item => item.metadata?.routineAutoOff === true)

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(START)
    const db = createClient({ url: 'file::memory:' }); clients.push(db); state.client = db
    await gate.initializeUsageGate('on')
    Object.assign(state, { files: {}, due: new Set(), runs: [], sent: [], notes: [], sessions: 0, providerRefused: false, sessionFails: false, claim: true, agentEnabled: () => true, paused: new Set(), authorize: async () => {}, preset: null })
    configureDesktopSchedules({ authorize: () => state.authorize(), adopt: async () => {}, model: async () => state.preset ? state.preset() : null, backup: async () => null })
})

afterEach(async () => {
    for (const run of state.runs) run.finish({ kind: 'done' })
    await settle()
    forgetPlanLimits('mac-chatgpt')
    vi.useRealTimers(); vi.restoreAllMocks()
    for (const db of clients.splice(0)) db.close()
})

describe('a firing that fails before a run starts, for a standing fault', () => {
    it('counts an incomplete saved model once per firing, however many ticks retry it', async () => {
        schedule('digest', BROKEN)
        const stop = startScheduler(); await settle()
        expect(await failures('digest')).toBe(1)
        // Never stamped, so it stays due and every tick tries again: still the ten o'clock firing.
        await tick(); await tick(); await tick()
        expect(state.due.has('digest')).toBe(true)
        expect(await failures('digest')).toBe(1)
        // Eleven o'clock comes round: a second firing.
        await tick(HOUR)
        expect(await failures('digest')).toBe(2)
        expect(state.runs).toHaveLength(0)
        await stop.drain()
    })

    it('switches the routine off on the tenth firing and tells the person exactly once', async () => {
        schedule('digest', BROKEN)
        const stop = startScheduler(); await settle()
        for (let firing = 2; firing < ROUTINE_FAILURES_BEFORE_OFF; firing += 1) await tick(HOUR)
        expect(await failures('digest')).toBe(ROUTINE_FAILURES_BEFORE_OFF - 1)
        expect(state.files.digest.enabled).toBe(true)
        expect(notices()).toHaveLength(0)

        await tick(HOUR)
        expect(state.files.digest.enabled).toBe(false)
        expect(await failures('digest')).toBe(0)
        // One notice of its own, in a conversation made to hold it, and nothing more on later ticks.
        await tick(HOUR); await tick(HOUR)
        expect(notices()).toHaveLength(1)
        expect(notices()[0]).toMatchObject({
            event: 'agent.notification', kind: 'error', agentId: 'on', sessionId: 'sess-1', runId: null, source: 'schedule',
            message: 'Daily digest was turned off after 10 failed runs in a row. Turn it back on in Mira’s Routines.',
            metadata: { routineAutoOff: true, scheduleSlug: 'digest', sourceName: 'Daily digest', coworkerName: 'Mira', disabledAt: expect.any(String) },
        })
        expect(state.notes).toHaveLength(1)
        expect(state.notes[0]).toMatchObject({ sessionId: 'sess-1' })
        expect(String(state.notes[0].content)).toContain('Last error: This routine’s saved model selection is incomplete.')
        expect(state.runs).toHaveLength(0)
        await stop.drain()
    })

    it('counts a provider the desktop policy refuses', async () => {
        schedule('digest'); state.providerRefused = true
        const stop = startScheduler(); await settle()
        expect(await failures('digest')).toBe(1)
        await stop.drain()
    })

    it('counts a Rerun preset that no connected plan can answer', async () => {
        schedule('digest'); state.preset = async () => { throw new HttpError(409, 'Connect a plan to use this preset.') }
        const stop = startScheduler(); await settle()
        expect(await failures('digest')).toBe(1)
        await stop.drain()
    })

    it('counts run preparation that throws', async () => {
        schedule('digest'); state.sessionFails = true
        const stop = startScheduler(); await settle()
        expect(await failures('digest')).toBe(1)
        // This firing was stamped before it broke, so the next tick does not try it again.
        expect(state.due.has('digest')).toBe(false)
        await tick()
        expect(await failures('digest')).toBe(1)
        await stop.drain()
    })

    it('starts the count over when a run succeeds', async () => {
        schedule('digest', BROKEN)
        const stop = startScheduler(); await settle()
        await tick(HOUR)
        expect(await failures('digest')).toBe(2)
        await health.settleDesktopRoutineRun({ agentId: 'on', runId: 'ok-1', slug: 'digest', name: 'Daily digest', kind: 'done', text: 'Sent.', routine: { parts: [], test: false } })
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })
})

describe('a firing that fails before a run starts, for anything else', () => {
    it('does not count a plan out of usage: the occurrence is parked', async () => {
        recordPlanLimits('mac-chatgpt', [{ kind: 'session', label: null, usedPercent: 100, resetsAt: '2026-11-16T15:00:00.000Z' }])
        schedule('digest')
        const stop = startScheduler(); await settle()
        expect(await gate.readUsageWait('on', 'digest')).toMatchObject({ state: 'waiting' })
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })

    it('does not count a "Run now" that meets the same standing fault', async () => {
        const task = schedule('digest', BROKEN); state.due.clear()
        const stop = startScheduler(); await settle()
        await expect(fireSchedule('on', task, { markFired: false, manualId: 'manual-1' })).rejects.toThrow(/incomplete/)
        await settle()
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })

    it('does not count a coworker switched off while the firing was being prepared', async () => {
        schedule('digest', BROKEN)
        // The tick sees the coworker on; the launch reads it again and finds it off.
        let reads = 0
        state.agentEnabled = () => ++reads === 1
        const stop = startScheduler(); await settle()
        expect(reads).toBeGreaterThan(1)
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })

    it('does not count a routine paused while the firing was being prepared', async () => {
        schedule('digest', BROKEN); state.paused.add('digest')
        const stop = startScheduler(); await settle()
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })

    it('does not count an occurrence that was already claimed', async () => {
        schedule('digest'); state.claim = false
        const stop = startScheduler(); await settle()
        expect(state.runs).toHaveLength(0)
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })

    it('does not count the app refusing the firing', async () => {
        schedule('digest', BROKEN); state.authorize = async () => { throw new Error('Scheduled tasks are disabled for this coworker') }
        const stop = startScheduler(); await settle()
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })

    it('does not count a firing cut short by the scheduler stopping', async () => {
        schedule('digest', BROKEN)
        // The preset answer is still on its way when the scheduler stops; it then fails like a standing fault.
        let fail!: (error: unknown) => void
        state.files.digest = { ...state.files.digest, connectionId: null, provider: null }
        state.preset = () => new Promise((_, reject) => { fail = reject })
        const stop = startScheduler(); await settle()
        stop()
        fail(new HttpError(409, 'Connect a plan to use this preset.'))
        await settle()
        expect(await failures('digest')).toBe(0)
        await stop.drain()
    })
})
