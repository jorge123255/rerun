import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

const dataRoot = mkdtempSync(resolve(tmpdir(), 'rerun-routine-runs-'))
const previousDesktop = process.env.RERUN_DESKTOP_APP
process.env.RERUN_DATA_DIR = dataRoot
process.env.RERUN_API_KEY = ''
process.env.RERUN_LOG_LEVEL = 'fatal'
process.env.RERUN_DESKTOP_APP = '1'

const sent = vi.hoisted(() => [] as Array<Record<string, unknown> & { metadata: Record<string, unknown> }>)
vi.mock('../runtime/notify.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../runtime/notify.js')>()),
    sendNotification: async (input: Record<string, unknown> & { metadata: Record<string, unknown> }) => { if (input.event !== 'agent.schedule.created') sent.push(input); return { delivered: true } },
}))

const { afterAll, beforeEach, describe, expect, it } = await import('vitest')
const { ROUTINE_FAILURES_BEFORE_OFF, ROUTINE_GUARD_MESSAGES, desktopRoutineHealthSchema, routineChecklistSummary } = await import('@rerun/contracts')
const { countDesktopRoutineStartFailure, readDesktopRoutineHealth, settleDesktopRoutineRun } = await import('./routine-runs.js')
const { createDesktopWorkspaceRoutineRouter } = await import('./workspace-routines/router.js')
const { emitRunTerminal } = await import('../runtime/run-events.js')
const { listRunCompletions } = await import('../db/completed-runs.js')
const { closeSystemDb } = await import('../db/systemDb.js')
const { readSchedule, setScheduleEnabled, writeSchedule } = await import('../schedules/loader.js')

const owners = new Set<string>()
let runs = 0
async function routine(agentId: string, name = 'Daily digest') {
    owners.add(agentId)
    return writeSchedule(agentId, { name, body: 'Send the digest.', cron: '0 8 * * *', timezone: 'UTC' })
}
const parts = ['Pull the cycle', 'Match it against the page', 'Rank what is left', 'Post the summary']
function terminal(agentId: string, slug: string, overrides: Partial<Parameters<typeof settleDesktopRoutineRun>[0]> = {}) {
    return { agentId, runId: `run-${++runs}`, slug, name: 'Daily digest', kind: 'done' as const, routine: { parts: [] as string[], test: false }, ...overrides }
}
async function healthOf(agentId: string, slug: string) {
    const schedule = await readSchedule(agentId, slug)
    return (await readDesktopRoutineHealth(agentId, [schedule])).get(slug)!
}

beforeEach(() => { sent.length = 0 })
afterAll(() => {
    for (const owner of owners) closeSystemDb(owner)
    rmSync(dataRoot, { recursive: true, force: true })
    if (previousDesktop === undefined) delete process.env.RERUN_DESKTOP_APP
    else process.env.RERUN_DESKTOP_APP = previousDesktop
})

describe('routine checklist outcome on the run', () => {
    it('records each part as done, blocked or skipped with its reason', async () => {
        const { slug } = await routine('checklist')
        const run = terminal('checklist', slug, { routine: { parts, test: false }, text: 'All sorted.\n\n1. Done\n2. Done\n3. Blocked: Notion returned 403\n4. Done' })
        await settleDesktopRoutineRun(run)
        const { lastOutcome } = await healthOf('checklist', slug)
        expect(lastOutcome?.runId).toBe(run.runId)
        expect(lastOutcome?.checklist?.parts.map(part => [part.number, part.status, part.reason])).toEqual([[1, 'done', null], [2, 'done', null], [3, 'blocked', 'Notion returned 403'], [4, 'done', null]])
        expect(routineChecklistSummary(lastOutcome!.checklist!)).toBe('3 done, 1 blocked: Notion returned 403')
    })

    it('records a reply without the list as "no checklist reported", not as a failure', async () => {
        const { slug } = await routine('no-list')
        await settleDesktopRoutineRun(terminal('no-list', slug, { routine: { parts, test: false }, text: 'I looked at everything and it is fine.' }))
        const health = await healthOf('no-list', slug)
        expect(health.lastOutcome?.checklist?.reported).toBe(false)
        expect(routineChecklistSummary(health.lastOutcome!.checklist!)).toBe('no checklist reported')
        expect(health.consecutiveFailures).toBe(0)
    })

    it('keeps no checklist for a routine without numbered parts and marks a test run', async () => {
        const { slug } = await routine('plain')
        await settleDesktopRoutineRun(terminal('plain', slug, { routine: { parts: [], test: true }, text: 'Sent.' }))
        expect((await healthOf('plain', slug)).lastOutcome).toMatchObject({ checklist: null, test: true, quiet: false })
    })
})

describe('auto-off after repeated failures', () => {
    it('switches the routine off on the tenth failure in a row and says how to turn it back on', async () => {
        const { slug } = await routine('breaks')
        for (let index = 1; index < ROUTINE_FAILURES_BEFORE_OFF; index += 1) {
            expect((await settleDesktopRoutineRun(terminal('breaks', slug, { kind: 'error' }))).autoDisabled).toBeNull()
        }
        expect((await readSchedule('breaks', slug)).enabled).toBe(true)
        expect((await healthOf('breaks', slug)).consecutiveFailures).toBe(ROUTINE_FAILURES_BEFORE_OFF - 1)
        const last = await settleDesktopRoutineRun(terminal('breaks', slug, { kind: 'error' }))
        expect(last.autoDisabled).toBe(ROUTINE_GUARD_MESSAGES.autoOff)
        expect(last.autoDisabled).toMatch(/turned off after failing 10 times in a row/)
        expect(last.autoDisabled).toMatch(/Switch it back on/)
        expect((await readSchedule('breaks', slug)).enabled).toBe(false)
        const health = await healthOf('breaks', slug)
        expect(health.autoDisabledAt).toEqual(expect.any(String))
        // The count starts over, and switching it back on clears the stamp.
        expect(health.consecutiveFailures).toBe(0)
        await setScheduleEnabled('breaks', slug, true)
        expect((await healthOf('breaks', slug)).autoDisabledAt).toBeNull()
    })

    it('resets the count on a success', async () => {
        const { slug } = await routine('recovers')
        for (let index = 0; index < ROUTINE_FAILURES_BEFORE_OFF - 1; index += 1) await settleDesktopRoutineRun(terminal('recovers', slug, { kind: 'error' }))
        await settleDesktopRoutineRun(terminal('recovers', slug, { text: 'Sent.' }))
        expect((await healthOf('recovers', slug)).consecutiveFailures).toBe(0)
        for (let index = 0; index < ROUTINE_FAILURES_BEFORE_OFF - 1; index += 1) await settleDesktopRoutineRun(terminal('recovers', slug, { kind: 'error' }))
        expect((await readSchedule('recovers', slug)).enabled).toBe(true)
    })

    it('does not count a stopped run, a hand-started test, or a run rebuilt after a restart', async () => {
        const { slug } = await routine('uncounted')
        for (let index = 0; index < ROUTINE_FAILURES_BEFORE_OFF + 2; index += 1) {
            await settleDesktopRoutineRun(terminal('uncounted', slug, { kind: 'error', routine: { parts: [], test: true } }))
            await settleDesktopRoutineRun(terminal('uncounted', slug, { kind: 'error', routine: undefined }))
            await settleDesktopRoutineRun(terminal('uncounted', slug, { kind: 'done', cancelled: true }))
        }
        expect((await healthOf('uncounted', slug)).consecutiveFailures).toBe(0)
        expect((await readSchedule('uncounted', slug)).enabled).toBe(true)
    })

    it('tells the person about the switch-off in one notification of its own, after the failed run’s', async () => {
        const { slug } = await routine('announced')
        const trigger = { source: 'schedule' as const, slug, name: 'Daily digest', routine: { parts: [], test: false } }
        for (let index = 0; index < ROUTINE_FAILURES_BEFORE_OFF; index += 1) {
            await emitRunTerminal({ agentId: 'announced', sessionId: 's1', runId: `fail-${index}`, trigger, kind: 'error', error: 'model unavailable' })
        }
        // Ten failed runs, each with its own plain failure, then the one notice.
        expect(sent).toHaveLength(ROUTINE_FAILURES_BEFORE_OFF + 1)
        const failed = sent.slice(0, ROUTINE_FAILURES_BEFORE_OFF)
        expect(failed.every(item => item.event === 'agent.schedule.completed' && item.metadata.error === 'model unavailable')).toBe(true)
        expect(failed.at(-2)!.metadata.routineAutoDisabled).toBeUndefined()
        expect(failed.at(-1)!.metadata.routineAutoDisabled).toBe(true)
        expect(sent.at(-1)).toMatchObject({
            event: 'agent.notification', kind: 'error', agentId: 'announced', sessionId: 's1', runId: `fail-${ROUTINE_FAILURES_BEFORE_OFF - 1}`, source: 'schedule',
            metadata: { routineAutoOff: true, scheduleSlug: slug, sourceName: 'Daily digest', disabledAt: expect.any(String) },
        })
        expect(sent.at(-1)!.message).toMatch(/^Daily digest was turned off after 10 failed runs in a row\. Turn it back on in .+’s Routines\.$/)
        // An eleventh failure of the routine, switched back on, is an ordinary failure again.
        await setScheduleEnabled('announced', slug, true)
        await emitRunTerminal({ agentId: 'announced', sessionId: 's1', runId: 'fail-again', trigger, kind: 'error', error: 'model unavailable' })
        expect(sent.filter(item => item.metadata.routineAutoOff === true)).toHaveLength(1)
    })

    it('counts a firing that could not start once per firing, and switches off on the tenth', async () => {
        const { slug } = await routine('cannot-start')
        const at = (hour: number) => new Date(Date.UTC(2026, 10, 16, hour))
        let again = true
        const count = (hour: number) => countDesktopRoutineStartFailure({ agentId: 'cannot-start', slug, now: at(hour), firedSince: () => again })
        expect(await count(1)).toEqual({ counted: true, autoDisabledAt: null })
        // The same firing tried again on a later tick is not a second failure.
        again = false
        expect(await count(1)).toEqual({ counted: false, autoDisabledAt: null })
        expect((await healthOf('cannot-start', slug)).consecutiveFailures).toBe(1)
        again = true
        for (let hour = 2; hour < ROUTINE_FAILURES_BEFORE_OFF; hour += 1) expect((await count(hour)).autoDisabledAt).toBeNull()
        // Failed runs and firings that could not start add up to the same ten.
        expect((await healthOf('cannot-start', slug)).consecutiveFailures).toBe(ROUTINE_FAILURES_BEFORE_OFF - 1)
        const last = await count(ROUTINE_FAILURES_BEFORE_OFF)
        expect(last).toEqual({ counted: true, autoDisabledAt: at(ROUTINE_FAILURES_BEFORE_OFF).toISOString() })
        expect((await readSchedule('cannot-start', slug)).enabled).toBe(false)
        expect((await healthOf('cannot-start', slug)).consecutiveFailures).toBe(0)
    })

    it('adds a firing that could not start to the failed runs before it, and a success clears both', async () => {
        const { slug } = await routine('mixed-failures')
        await settleDesktopRoutineRun(terminal('mixed-failures', slug, { kind: 'error' }))
        await countDesktopRoutineStartFailure({ agentId: 'mixed-failures', slug, firedSince: () => true })
        expect((await healthOf('mixed-failures', slug)).consecutiveFailures).toBe(2)
        await settleDesktopRoutineRun(terminal('mixed-failures', slug, { text: 'Sent.' }))
        expect((await healthOf('mixed-failures', slug)).consecutiveFailures).toBe(0)
    })
})

describe('quiet runs', () => {
    const quietTrigger = (slug: string) => ({ source: 'schedule' as const, slug, name: 'Daily digest', routine: { parts: [], test: false } })

    it('records a marker-only reply as done with no completion, so nothing notifies, marks unread or reaches the inbox', async () => {
        const { slug } = await routine('quiet')
        await emitRunTerminal({ agentId: 'quiet', sessionId: 's1', runId: 'quiet-1', trigger: quietTrigger(slug), kind: 'done', text: '  [[no-update]]\n' })
        expect(await listRunCompletions('quiet', { limit: 10 })).toEqual([])
        expect(sent.at(-1)).toMatchObject({ kind: 'done', event: 'agent.schedule.completed' })
        expect(sent.at(-1)!.metadata).toMatchObject({ quiet: true, status: 'done' })
        expect(sent.at(-1)!.metadata.finalText).toBeUndefined()
        expect((await healthOf('quiet', slug)).lastOutcome).toMatchObject({ runId: 'quiet-1', quiet: true })
    })

    it('still notifies for a normal reply', async () => {
        const { slug } = await routine('loud')
        await emitRunTerminal({ agentId: 'loud', sessionId: 's1', runId: 'loud-1', trigger: quietTrigger(slug), kind: 'done', text: 'Three new issues were filed.' })
        expect(await listRunCompletions('loud', { limit: 10 })).toMatchObject([{ id: 'loud-1', source: 'schedule', slug, text: 'Three new issues were filed.' }])
        expect(sent.at(-1)!.metadata.quiet).toBeUndefined()
        expect((await healthOf('loud', slug)).lastOutcome).toMatchObject({ quiet: false })
    })

    it('treats the marker beside other text as a normal reply with the marker removed', async () => {
        const { slug } = await routine('mixed')
        await emitRunTerminal({ agentId: 'mixed', sessionId: 's1', runId: 'mixed-1', trigger: quietTrigger(slug), kind: 'done', text: 'One invoice is overdue.\n\n[[no-update]]' })
        expect(await listRunCompletions('mixed', { limit: 10 })).toMatchObject([{ id: 'mixed-1', text: 'One invoice is overdue.' }])
        expect(sent.at(-1)!.metadata).toMatchObject({ finalText: 'One invoice is overdue.' })
        expect(sent.at(-1)!.metadata.quiet).toBeUndefined()
    })

    it('leaves a chat reply that mentions the marker alone', async () => {
        owners.add('chatty')
        await emitRunTerminal({ agentId: 'chatty', sessionId: 's1', runId: 'chat-1', trigger: { source: 'chat' }, kind: 'done', text: '[[no-update]]' })
        expect(await listRunCompletions('chatty', { limit: 10 })).toMatchObject([{ id: 'chat-1', text: '[[no-update]]' }])
    })
})

describe('the health the routine lists read', () => {
    it('reports warnings for a saved routine over a limit, its failure count and its last outcome, without changing it', async () => {
        owners.add('health')
        const fast = await writeSchedule('health', { name: 'Fast poll', body: 'Poll.', cron: '*/5 * * * *', timezone: 'UTC' })
        const slow = await writeSchedule('health', { name: 'Slow poll', body: 'Poll.', cron: '0 9 * * *', timezone: 'UTC' })
        await settleDesktopRoutineRun(terminal('health', fast.slug, { kind: 'error' }))
        await settleDesktopRoutineRun(terminal('health', slow.slug, { runId: 'slow-1', text: '[[no-update]]' }))
        const response = await createDesktopWorkspaceRoutineRouter().request('/health/health')
        expect(response.status).toBe(200)
        const view = desktopRoutineHealthSchema.parse(await response.json())
        expect(view.limit).toBe(20)
        expect(view.routines.find(row => row.slug === fast.slug)).toMatchObject({ warnings: ['interval'], consecutiveFailures: 1, autoDisabledAt: null, lastOutcome: null })
        expect(view.routines.find(row => row.slug === slow.slug)).toMatchObject({ warnings: [], consecutiveFailures: 0, lastOutcome: { runId: 'slow-1', quiet: true } })
        expect(await readSchedule('health', fast.slug)).toMatchObject({ enabled: true, cron: '*/5 * * * *' })
    })
})
