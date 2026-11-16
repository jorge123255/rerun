import { createClient } from '@libsql/client'
import { vi } from 'vitest'

process.env.RERUN_LOG_LEVEL = 'fatal'

type Outcome = { kind: 'done' | 'error' | 'cancelled'; error?: string; errorCode?: string }
type Run = { override: { connectionId?: string; provider?: string; model?: string }; trigger: { usageGate?: unknown; requireExactModel?: boolean }; finish: (outcome: Outcome) => void }

const state = vi.hoisted(() => ({
    client: null as unknown,
    files: {} as Record<string, Record<string, unknown>>,
    due: new Set<string>(),
    runs: [] as Run[],
    sent: [] as Array<Record<string, unknown>>,
    backup: null as { connectionId: string; model: string; note: string } | null,
    backupAsked: [] as string[],
    preset: null as (() => Promise<{ connectionId: string; model: string } | null>) | null,
}))

vi.mock('../db/systemDb.js', () => ({ getSystemDb: async () => ({ client: state.client }) }))
vi.mock('../desktop/policy.js', () => ({ desktopApp: () => true, assertDesktopProvider: () => {} }))
vi.mock('../desktop/workspace-admission.js', () => ({ assertDesktopRunAdmission: () => 0 }))
vi.mock('./desktop-schedule-state.js', () => ({ replayDesktopSchedule: async () => null, claimDesktopSchedule: async () => true, recordDesktopSchedule: async () => {}, finishDesktopSchedule: async () => {} }))
vi.mock('../agents/availability.js', () => ({
    // The coworker's own model: the ChatGPT plan.
    automationModel: async () => ({ connectionId: 'mac-chatgpt', provider: 'codex', model: 'gpt-plan' }),
    resolveRunModel: async (_agent: unknown, override: { connectionId: string; provider: string; model: string }) => ({
        connection: { id: override.connectionId, config: { name: override.connectionId === 'mac-chatgpt' ? 'ChatGPT' : override.connectionId } }, provider: override.provider ?? 'openai', model: override.model,
    }),
    isUsable: () => true,
}))
vi.mock('../agents/loader.js', () => ({ listAgentIdsOnDisk: async () => ['on'] }))
vi.mock('../agents/registry.js', () => ({ getAgent: async (id: string) => ({ id, config: { enabled: true }, resolved: { provider: 'codex', connection: undefined } }) }))
vi.mock('../db/repos/sessions.js', () => ({ createSession: async () => ({ id: `sess-${state.runs.length + 1}` }) }))
vi.mock('../schedules/loader.js', () => ({
    readSchedule: async (_agentId: string, slug: string) => state.files[slug],
    listSchedules: async () => Object.values(state.files),
    markFired: async () => {},
    consumeDesktopSchedule: async (_agentId: string, current: { slug: string; runAt: string | null; enabled: boolean }, firedAt: string) => {
        state.due.delete(current.slug)
        return state.files[current.slug] = { ...current, lastRunAt: firedAt, enabled: current.runAt ? false : current.enabled }
    },
}))
vi.mock('../schedules/cron.js', () => ({ isDue: (schedule: { slug: string }) => state.due.has(schedule.slug) }))
vi.mock('../memory/maintenance.js', () => ({ sweepMemoriesIfDue: async () => {} }))
vi.mock('../brain/maintenance.js', () => ({ maintainBrainIfDue: async () => {} }))
vi.mock('../connections/codex-sweep.js', () => ({ sweepCodexHomesIfDue: async () => {} }))
vi.mock('./notify.js', () => ({ sendNotification: async (input: Record<string, unknown>) => { state.sent.push(input); return { delivered: true } } }))
vi.mock('./headless-run.js', () => ({
    startHeadlessRun: async (_agent: unknown, _sessionId: string, _message: string, override: Run['override'], trigger: Run['trigger']) => {
        let finish!: (outcome: Outcome) => void
        const settled = new Promise<Outcome>(resolve => (finish = resolve))
        state.runs.push({ override, trigger, finish })
        return { runId: `run-${state.runs.length}`, settled }
    },
}))

const { afterEach, beforeEach, expect, it } = await import('vitest')
const { fireSchedule, startScheduler, configureDesktopSchedules } = await import('./scheduler.js')
const gate = await import('../desktop/usage-gate.js')
const { recordPlanLimits, forgetPlanLimits } = await import('../connections/plan-limits.js')
const { logger } = await import('../lib/logger.js')
type Schedule = import('../schedules/loader.js').Schedule

const START = new Date('2026-11-16T10:00:00.000Z')
const RESET = '2026-11-16T15:00:00.000Z'
const clients: ReturnType<typeof createClient>[] = []

function schedule(slug: string, extra: Partial<Schedule> = {}): Schedule {
    const value = { slug, name: `Name ${slug}`, description: '', enabled: true, cron: '0 * * * *', runAt: null, timezone: null, lastRunAt: null, connectionId: null, provider: null, model: null, body: 'work', createdAt: '2026-01-01T00:00:00.000Z', ...extra } as Schedule
    state.files[slug] = value as unknown as Record<string, unknown>
    return value
}
const full = (resetsAt: string | null) => recordPlanLimits('mac-chatgpt', [{ kind: 'session', label: null, usedPercent: 100, resetsAt }])
const settle = async () => { for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0) }
const tick = async (ms = 30_000) => { await vi.advanceTimersByTimeAsync(ms); await settle() }

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(START)
    const db = createClient({ url: 'file::memory:' }); clients.push(db); state.client = db
    await gate.initializeUsageGate('on')
    state.files = {}; state.due = new Set(); state.runs = []; state.sent = []; state.backup = null; state.backupAsked = []; state.preset = null
    configureDesktopSchedules({
        authorize: async () => {}, adopt: async () => {},
        model: async () => state.preset ? state.preset() : null,
        backup: async (_agentId, out) => { state.backupAsked.push(out); return state.backup },
    })
})

afterEach(async () => {
    for (const run of state.runs) run.finish({ kind: 'done' })
    await settle()
    forgetPlanLimits('mac-chatgpt')
    vi.useRealTimers(); vi.restoreAllMocks()
    for (const db of clients.splice(0)) db.close()
})

it('parks a routine whose plan is out of usage instead of starting or failing it', async () => {
    const errors = vi.spyOn(logger, 'error')
    full(RESET)
    const task = schedule('daily'); state.due.add('daily')
    const stop = startScheduler(); await settle()

    expect(state.runs).toHaveLength(0)
    // No session, no run and no notification: nothing a failure counter could count.
    expect(state.sent).toHaveLength(0)
    expect(errors).not.toHaveBeenCalled()
    const wait = await gate.readUsageWait('on', 'daily')
    expect(wait).toMatchObject({ plan: 'ChatGPT', connectionId: 'mac-chatgpt', resetsAt: RESET, state: 'waiting', skippedWhileWaiting: 0 })
    // The occurrence was consumed, so the routine is not fired again on every tick.
    expect(state.files[task.slug]).toMatchObject({ lastRunAt: START.toISOString() })
    await stop.drain()
})

it('skips a later firing while parked, keeping one parked occurrence', async () => {
    full(RESET)
    schedule('daily'); state.due.add('daily')
    const stop = startScheduler(); await settle()
    state.due.add('daily')
    await tick()

    expect(state.runs).toHaveLength(0)
    expect(await gate.listUsageWaits('on')).toHaveLength(1)
    expect(await gate.readUsageWait('on', 'daily')).toMatchObject({ parkedAt: START.toISOString(), skippedWhileWaiting: 1 })
    expect(state.due.has('daily')).toBe(false)
    await stop.drain()
})

it('runs the parked routine once when the plan resets, and stops waiting when it finishes', async () => {
    full(RESET)
    schedule('daily'); state.due.add('daily')
    const stop = startScheduler(); await settle()

    vi.setSystemTime(new Date('2026-11-16T14:59:00.000Z')); await tick()
    expect(state.runs).toHaveLength(0)

    vi.setSystemTime(new Date('2026-11-16T15:01:00.000Z')); await tick()
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]!.override).toMatchObject({ connectionId: 'mac-chatgpt' })
    expect(state.runs[0]!.trigger.usageGate).toEqual({ connectionId: 'mac-chatgpt', plan: 'ChatGPT', provider: 'codex' })
    expect(await gate.readUsageWait('on', 'daily')).toMatchObject({ state: 'running' })
    // While it runs, another tick does not start it a second time.
    await tick()
    expect(state.runs).toHaveLength(1)

    state.runs[0]!.finish({ kind: 'done' }); await settle()
    expect(await gate.readUsageWait('on', 'daily')).toBeNull()
    await stop.drain()
})

it('keeps a parked routine across a restart and resumes it at reset', async () => {
    full(RESET)
    schedule('daily'); state.due.add('daily')
    const first = startScheduler(); await settle()
    await first.drain()

    // The app starts again: the same database, a new scheduler.
    await gate.initializeUsageGate('on')
    expect(await gate.readUsageWait('on', 'daily')).toMatchObject({ state: 'waiting', resetsAt: RESET })
    vi.setSystemTime(new Date('2026-11-16T15:01:00.000Z'))
    const second = startScheduler(); await settle()

    expect(state.runs).toHaveLength(1)
    await second.drain()
})

it('does not run a resumed routine twice when the app quit in the middle of it', async () => {
    await gate.parkSchedule('on', 'daily', { connectionId: 'mac-chatgpt', plan: 'ChatGPT' }, RESET, START)
    await gate.markUsageWaitRunning('on', 'daily')
    await gate.initializeUsageGate('on')
    expect(await gate.readUsageWait('on', 'daily')).toBeNull()
})

it('keeps waiting, inside the same 24 hours, when the plan refuses the resumed run again', async () => {
    schedule('daily')
    // The provider refused a run and gave no reset time: checked again every 15 minutes.
    const target = { connectionId: 'mac-chatgpt', plan: 'ChatGPT', provider: 'codex' }
    expect(await gate.parkRefusedScheduledRun({ agentId: 'on', slug: 'daily', target, error: "You've hit your usage limit." })).toContain('Waiting for ChatGPT')
    const stop = startScheduler(); await settle()
    // The first look is at once, to ask about a backup model; there is none.
    expect(state.backupAsked).toEqual(['mac-chatgpt'])
    expect(state.runs).toHaveLength(0)

    await tick(15 * 60_000 + 30_000)
    expect(state.runs).toHaveLength(1)
    // What the run loop does with the refusal: park it again and stop the run without failing it.
    await gate.parkRefusedScheduledRun({ agentId: 'on', slug: 'daily', target, error: "You've hit your usage limit." })
    state.runs[0]!.finish({ kind: 'cancelled' }); await settle()

    expect(await gate.readUsageWait('on', 'daily')).toMatchObject({ state: 'waiting', parkedAt: START.toISOString(), recheckSince: START.toISOString() })
    await stop.drain()
})

it('records the occurrence as skipped, with a plain reason, after 24 hours without a reset time', async () => {
    const target = { connectionId: 'mac-chatgpt', plan: 'ChatGPT', provider: 'codex' }
    const refuse = (now: Date) => gate.parkRefusedScheduledRun({ agentId: 'on', slug: 'daily', target, error: 'usage limit reached', now })
    await refuse(START)
    expect(await refuse(new Date(START.getTime() + 23 * 3_600_000))).toContain('Waiting for ChatGPT')
    expect(await refuse(new Date(START.getTime() + 24 * 3_600_000))).toBe('Skipped: ChatGPT was still out of usage after 24 hours.')

    expect(await gate.readUsageWait('on', 'daily')).toBeNull()
    expect(await gate.listUsageSkips('on')).toEqual([{ slug: 'daily', at: new Date(START.getTime() + 24 * 3_600_000).toISOString(), reason: 'Skipped: ChatGPT was still out of usage after 24 hours.' }])
})

it('leaves an ordinary failure alone: a model outside the plan, or a key billed per token', async () => {
    const plan = { connectionId: 'mac-chatgpt', plan: 'ChatGPT', provider: 'codex' }
    expect(await gate.parkRefusedScheduledRun({ agentId: 'on', slug: 'daily', target: plan, error: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." })).toBeNull()
    expect(await gate.parkRefusedScheduledRun({ agentId: 'on', slug: 'daily', target: { connectionId: 'key', plan: 'OpenAI', provider: 'openai' }, error: 'OpenAI API credits used up' })).toBeNull()
    expect(await gate.listUsageWaits('on')).toHaveLength(0)
})

it('does not park a run the owner started by hand', async () => {
    full(RESET)
    const task = schedule('daily')
    const stop = startScheduler(); await settle()
    await fireSchedule('on', task, { markFired: false, manualId: 'by-hand' })
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]!.trigger.usageGate).toBeUndefined()
    expect(await gate.listUsageWaits('on')).toHaveLength(0)
    await stop.drain()
})

it('runs on the backup model the owner picked instead of waiting', async () => {
    full(RESET)
    state.backup = { connectionId: 'openai-key', model: 'gpt-paid', note: 'Backup model is answering on OpenAI · gpt-paid: ChatGPT is out of usage.' }
    schedule('daily'); state.due.add('daily')
    const stop = startScheduler(); await settle()

    expect(state.backupAsked).toEqual(['mac-chatgpt'])
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]!.override).toEqual({ connectionId: 'openai-key', provider: 'openai', model: 'gpt-paid' })
    expect(state.runs[0]!.trigger.requireExactModel).toBe(true)
    expect(await gate.listUsageWaits('on')).toHaveLength(0)
    await stop.drain()
})

it('moves a parked routine to the backup model once the owner sets one', async () => {
    full(RESET)
    schedule('later'); state.due.add('later')
    const stop = startScheduler(); await settle()
    expect(state.runs).toHaveLength(0)

    state.backup = { connectionId: 'openai-key', model: 'gpt-paid', note: 'note' }
    await tick(5 * 60_000 + 30_000)

    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]!.override).toMatchObject({ connectionId: 'openai-key', model: 'gpt-paid' })
    await stop.drain()
})

it('never asks for anything but the backup: with none, a full plan only waits', async () => {
    const stop = startScheduler(); await settle()
    full(RESET)
    const task = schedule('daily'); state.due.add('daily')
    await expect(fireSchedule('on', task)).rejects.toBeInstanceOf(gate.UsageWaitError)
    expect(state.runs).toHaveLength(0)
    await stop.drain()
})

it('tries a plan whose full window carries no reset time, since only a run can tell', async () => {
    const stop = startScheduler(); await settle()
    full(null)
    const task = schedule('daily'); state.due.add('daily')
    await fireSchedule('on', task)
    expect(state.runs).toHaveLength(1)
    await stop.drain()
})

it('parks a routine on a Rerun preset when the app says its plan is out of usage', async () => {
    const stop = startScheduler(); await settle()
    state.preset = async () => { throw new gate.DesktopPlanOutError('Rerun Smart has no plan with usage left (ChatGPT).', { connectionId: 'mac-chatgpt', plan: 'ChatGPT', provider: 'codex' }, RESET) }
    const task = schedule('daily'); state.due.add('daily')
    await expect(fireSchedule('on', task)).rejects.toThrow('Waiting for ChatGPT to reset at')
    expect(await gate.readUsageWait('on', 'daily')).toMatchObject({ resetsAt: RESET, plan: 'ChatGPT' })
    expect(state.runs).toHaveLength(0)
    await stop.drain()
})

it('stops waiting for a routine the owner paused or deleted', async () => {
    full(RESET)
    schedule('daily'); state.due.add('daily')
    const stop = startScheduler(); await settle()
    state.files.daily = { ...state.files.daily!, enabled: false }
    await tick()
    expect(await gate.listUsageWaits('on')).toHaveLength(0)
    await stop.drain()
})
