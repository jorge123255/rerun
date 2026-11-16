import { createClient } from '@libsql/client'
import { describe, expect, it } from 'vitest'
import { ROUTINE_GUARD_MESSAGES, ROUTINE_MAX_ENABLED, routineFiresTooOften } from '@rerun/contracts'
import { createDesktopRoutineGuard, desktopRoutineTooFrequent, desktopRoutineWarnings } from './routine-guards.js'
import { createDesktopScheduleLifecycle } from './schedule-tools/lifecycle.js'
import { createDesktopScheduleIntentStore } from './schedule-tools/intents.js'
import { memoryScheduleFiles } from './schedule-tools/files.js'
import { createDesktopScheduleToolFactory } from './schedule-tools/tools.js'
import { desktopScheduleDefinitionRevision } from './schedule-tools/revision.js'
import type { DesktopScheduleDefinition, DesktopScheduleOwner } from './schedule-tools/types.js'

const NOW = new Date('2026-09-30T06:00:00.000Z')
const others = (count: number) => Array.from({ length: count }, (_, index) => ({ agentId: 'other', slug: `routine-${index}` }))
const shape = (patch: Partial<{ enabled: boolean; cron: string | null; timezone: string | null }> = {}) => ({ enabled: true, cron: '0 9 * * *', timezone: 'UTC', ...patch })

describe('how often a routine fires', () => {
    it('finds a gap under fifteen minutes, including an uneven one', () => {
        expect(desktopRoutineTooFrequent({ cron: '*/5 * * * *', timezone: 'UTC' }, NOW)).toBe(true)
        expect(desktopRoutineTooFrequent({ cron: '*/14 * * * *', timezone: 'UTC' }, NOW)).toBe(true)
        expect(desktopRoutineTooFrequent({ cron: '0,5 9 * * *', timezone: 'UTC' }, NOW)).toBe(true)
        expect(desktopRoutineTooFrequent({ cron: '*/15 * * * *', timezone: 'UTC' }, NOW)).toBe(false)
        expect(desktopRoutineTooFrequent({ cron: '0 9 * * 1', timezone: 'Europe/Paris' }, NOW)).toBe(false)
        expect(desktopRoutineTooFrequent({ cron: null, timezone: 'UTC' }, NOW)).toBe(false)
    })
    it('treats a schedule with no further firing as fine', () => {
        expect(routineFiresTooOften(() => null, NOW)).toBe(false)
    })
})

describe('the save-time guard', () => {
    const guard = (enabled = 0) => createDesktopRoutineGuard({ listEnabled: async () => [...others(enabled), { agentId: 'eng-1', slug: 'mine' }], now: () => NOW })

    it('refuses a new recurring routine that would fire more often than every fifteen minutes', async () => {
        expect(await guard()('eng-1', 'mine', null, shape({ cron: '*/5 * * * *' }))).toBe('interval')
        expect(await guard()('eng-1', 'mine', null, shape({ cron: '*/5 * * * *', enabled: false }))).toBe('interval')
        expect(await guard()('eng-1', 'mine', null, shape({ cron: '*/15 * * * *' }))).toBeNull()
        expect(await guard()('eng-1', 'mine', null, shape({ cron: null }))).toBeNull()
    })
    it('refuses an edit to a faster schedule, and switching a too-frequent routine back on', async () => {
        expect(await guard()('eng-1', 'mine', shape(), shape({ cron: '*/10 * * * *' }))).toBe('interval')
        expect(await guard()('eng-1', 'mine', shape({ cron: '*/5 * * * *', enabled: false }), shape({ cron: '*/5 * * * *' }))).toBe('interval')
    })
    it('lets a routine saved before the limit keep running: other edits, pausing and deleting still work', async () => {
        const fast = shape({ cron: '*/5 * * * *' })
        expect(await guard()('eng-1', 'mine', fast, { ...fast })).toBeNull()
        expect(await guard()('eng-1', 'mine', fast, { ...fast, enabled: false })).toBeNull()
        expect(await guard()('eng-1', 'mine', fast, null)).toBeNull()
    })
    it('refuses the twenty-first enabled routine, on create and on enable', async () => {
        expect(await guard(ROUTINE_MAX_ENABLED)('eng-1', 'new', null, shape())).toBe('cap')
        expect(await guard(ROUTINE_MAX_ENABLED)('eng-1', 'mine', shape({ enabled: false }), shape())).toBe('cap')
        expect(await guard(ROUTINE_MAX_ENABLED - 1)('eng-1', 'mine', shape({ enabled: false }), shape())).toBeNull()
        // A routine created switched off does not take a place.
        expect(await guard(ROUTINE_MAX_ENABLED)('eng-1', 'new', null, shape({ enabled: false }))).toBeNull()
    })
    it('lets a workspace already over the cap edit and pause what it has', async () => {
        expect(await guard(ROUTINE_MAX_ENABLED + 5)('eng-1', 'mine', shape(), shape({ cron: '0 10 * * *' }))).toBeNull()
        expect(await guard(ROUTINE_MAX_ENABLED + 5)('eng-1', 'mine', shape(), shape({ enabled: false }))).toBeNull()
    })
    it('warns about saved routines that break a limit without changing them', () => {
        expect(desktopRoutineWarnings(shape({ cron: '*/5 * * * *' }), 3, NOW)).toEqual(['interval'])
        expect(desktopRoutineWarnings(shape(), ROUTINE_MAX_ENABLED + 1, NOW)).toEqual(['cap'])
        expect(desktopRoutineWarnings(shape(), ROUTINE_MAX_ENABLED, NOW)).toEqual([])
        expect(desktopRoutineWarnings(shape({ cron: '*/5 * * * *', enabled: false }), ROUTINE_MAX_ENABLED + 1, NOW)).toEqual([])
    })
})

describe('the coworker’s schedule tools', () => {
    function factory(enabledElsewhere = 0) {
        const files = memoryScheduleFiles()
        const client = createClient({ url: ':memory:' })
        const store = createDesktopScheduleIntentStore(async () => client)
        const owner: DesktopScheduleOwner = { localAgentId: 'local-1', engineAgentId: 'eng-1', enabled: true, deleting: false, setupPending: false, scheduleManage: true, connectedModel: { provider: 'openai', model: 'gpt-5' } }
        const authority = { assertActive() {}, resolveOwner: async () => owner, readRun: async () => ({ agentId: 'eng-1', sessionId: 'session-1', status: 'running' }), notify: async () => {} }
        const guard = createDesktopRoutineGuard({ now: () => NOW, listEnabled: async () => [...others(enabledElsewhere), ...(await files.list('eng-1')).filter(row => row.enabled).map(row => ({ agentId: 'eng-1', slug: row.slug }))] })
        const lifecycle = createDesktopScheduleLifecycle({ authority, files, store, now: () => NOW, guard })
        const tools = createDesktopScheduleToolFactory({ authority, lifecycle, store }).tools('eng-1', { runId: 'run-1', sessionId: 'session-1' })
        let calls = 0
        const call = async (name: keyof typeof tools, input: unknown) => (tools[name] as { execute: (value: never, options: { toolCallId: string }) => Promise<string> }).execute(input as never, { toolCallId: `call-${++calls}` })
        return { files, call }
    }
    const definition = (patch: Partial<DesktopScheduleDefinition>): DesktopScheduleDefinition => ({
        slug: 'sync', name: 'Sync', description: '', body: 'Sync it.', enabled: true, cron: '0 9 * * *', runAt: null, timezone: 'UTC', lastRunAt: null,
        connectionId: null, provider: null, model: null, createdAt: NOW.toISOString(), ...patch,
    })
    const create = { name: 'Sync', description: '', body: 'Sync it.', timezone: 'UTC' }

    it('refuses to create a routine that fires too often, with a plain message, and saves nothing', async () => {
        const { files, call } = factory()
        expect(await call('schedule_create', { ...create, cron: '*/5 * * * *' })).toBe(ROUTINE_GUARD_MESSAGES.interval)
        expect(await files.read('eng-1', 'sync')).toBeNull()
        expect(await call('schedule_create', { ...create, cron: '*/15 * * * *' })).toBe('Created schedule sync')
    })
    it('refuses to edit a routine to a faster schedule and keeps the saved one', async () => {
        const { files, call } = factory()
        const saved = definition({})
        files.seed('eng-1', saved)
        expect(await call('schedule_update', { slug: 'sync', expectedRevision: desktopScheduleDefinitionRevision(saved), cron: '* * * * *' })).toBe(ROUTINE_GUARD_MESSAGES.interval)
        expect((await files.read('eng-1', 'sync'))?.cron).toBe('0 9 * * *')
    })
    it('refuses to create or switch on a routine past the workspace cap', async () => {
        const { files, call } = factory(ROUTINE_MAX_ENABLED)
        expect(await call('schedule_create', { ...create, cron: '0 9 * * *' })).toBe(ROUTINE_GUARD_MESSAGES.cap)
        const paused = definition({ enabled: false })
        files.seed('eng-1', paused)
        expect(await call('schedule_update', { slug: 'sync', expectedRevision: desktopScheduleDefinitionRevision(paused), enabled: true })).toBe(ROUTINE_GUARD_MESSAGES.cap)
        expect((await files.read('eng-1', 'sync'))?.enabled).toBe(false)
    })
    it('still lets a routine that already breaks a limit be edited and paused', async () => {
        const { files, call } = factory(ROUTINE_MAX_ENABLED + 3)
        const fast = definition({ cron: '*/5 * * * *' })
        files.seed('eng-1', fast)
        expect(await call('schedule_edit', { slug: 'sync', expectedRevision: desktopScheduleDefinitionRevision(fast), oldString: 'Sync it.', newString: 'Sync it twice.', replaceAll: false })).toBe('Edited schedule sync (1 replacement)')
        const edited = (await files.read('eng-1', 'sync'))!
        expect(edited.cron).toBe('*/5 * * * *')
        expect(await call('schedule_update', { slug: 'sync', expectedRevision: desktopScheduleDefinitionRevision(edited), enabled: false })).toBe('Updated schedule sync')
    })
})
