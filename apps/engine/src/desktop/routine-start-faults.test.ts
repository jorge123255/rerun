import { describe, expect, it } from 'vitest'
import { HttpError, agentDisabled, budgetExhausted, setupPending } from '../lib/errors.js'
import { ROUTINE_START_FAILURES, classifyRoutineStartFailure, nameRoutineStartFailure, routineStartFailureCounts, routineStartStep, isConflict, type RoutineStartFailure } from './routine-start-faults.js'
import { DesktopPlanOutError, UsageWaitError } from './usage-gate.js'

const scheduled = (error: unknown, active = true) => classifyRoutineStartFailure({ error, scheduled: true, active })
const counted = (error: unknown) => routineStartFailureCounts(scheduled(error))

describe('a scheduled firing that could not start: what counts toward switching the routine off', () => {
    it('counts a saved model that is incomplete or unavailable', () => {
        const error = nameRoutineStartFailure(new HttpError(409, 'This routine’s saved model is unavailable.'), 'saved-model')
        expect(scheduled(error)).toBe('saved-model')
        expect(counted(error)).toBe(true)
    })

    it('counts a provider that is not connected or that the desktop policy refuses', () => {
        const error = nameRoutineStartFailure(new HttpError(400, 'This connection is unavailable in the desktop preview.'), 'provider')
        expect(scheduled(error)).toBe('provider')
        expect(counted(error)).toBe(true)
    })

    it('counts a coworker whose setup is pending', () => {
        const error = nameRoutineStartFailure(setupPending(), 'setup-pending')
        expect(scheduled(error)).toBe('setup-pending')
        expect(counted(error)).toBe(true)
    })

    it('counts run preparation that throws before the run exists', () => {
        const error = nameRoutineStartFailure(new Error('database is locked'), 'preparation')
        expect(scheduled(error)).toBe('preparation')
        expect(counted(error)).toBe(true)
    })
})

describe('a scheduled firing that could not start: what is left alone', () => {
    it('does not count an occurrence parked by the usage gate or refused for usage', () => {
        // Usage wins over whatever the step it was thrown in is called.
        const parked = nameRoutineStartFailure(new UsageWaitError('Waiting for ChatGPT to reset.'), 'preparation')
        const out = new DesktopPlanOutError('No plan left', { connectionId: 'c', plan: 'ChatGPT', provider: 'codex' }, null)
        for (const error of [parked, out, budgetExhausted()]) {
            expect(scheduled(error)).toBe('usage')
            expect(counted(error)).toBe(false)
        }
    })

    it('does not count a "Run now" or test run, whatever went wrong', () => {
        const error = nameRoutineStartFailure(new HttpError(409, 'saved model unavailable'), 'saved-model')
        const kind = classifyRoutineStartFailure({ error, scheduled: false, active: true })
        expect(kind).toBe('manual')
        expect(routineStartFailureCounts(kind)).toBe(false)
    })

    it('does not count a parked occurrence the usage gate tried again', () => {
        const error = nameRoutineStartFailure(new HttpError(409, 'saved model unavailable'), 'saved-model')
        const kind = classifyRoutineStartFailure({ error, scheduled: false, usageResume: true, active: true })
        expect(kind).toBe('usage-resume')
        expect(routineStartFailureCounts(kind)).toBe(false)
    })

    it('does not count the coworker being switched off', () => {
        const error = nameRoutineStartFailure(agentDisabled(), 'coworker-off')
        expect(scheduled(error)).toBe('coworker-off')
        expect(counted(error)).toBe(false)
    })

    it('does not count the routine being paused', () => {
        const error = nameRoutineStartFailure(new HttpError(409, 'Task is paused.'), 'paused')
        expect(scheduled(error)).toBe('paused')
        expect(counted(error)).toBe(false)
    })

    it('does not count an occurrence already claimed or no longer due', () => {
        const error = nameRoutineStartFailure(new Error('Occurrence already claimed or task already active'), 'skipped')
        expect(scheduled(error)).toBe('skipped')
        expect(counted(error)).toBe(false)
    })

    it('does not count a routine or coworker edited or deleted during preparation', () => {
        const error = nameRoutineStartFailure(new Error('Task changed during preparation'), 'changed')
        expect(scheduled(error)).toBe('changed')
        expect(counted(error)).toBe(false)
    })

    it('does not count the app refusing or failing to answer', () => {
        const error = nameRoutineStartFailure(new Error('Scheduled tasks are disabled for this coworker'), 'authorization')
        expect(scheduled(error)).toBe('authorization')
        expect(counted(error)).toBe(false)
    })

    it('does not count anything while the app or engine is shutting down, even a standing fault', () => {
        const named = nameRoutineStartFailure(new Error('Scheduler stopped'), 'shutdown')
        expect(scheduled(named)).toBe('shutdown')
        const fault = nameRoutineStartFailure(new HttpError(409, 'saved model unavailable'), 'saved-model')
        expect(scheduled(fault, false)).toBe('shutdown')
        expect(routineStartFailureCounts('shutdown')).toBe(false)
    })

    it('does not count again what the run itself already settled', () => {
        const error = nameRoutineStartFailure(new Error('model unavailable'), 'preparation')
        nameRoutineStartFailure(error, 'inside-run', true)
        expect(scheduled(error)).toBe('inside-run')
        expect(counted(error)).toBe(false)
    })

    it('does not count a failure nobody named', () => {
        expect(scheduled(new Error('something else'))).toBe('unclassified')
        expect(scheduled('a string')).toBe('unclassified')
        expect(counted(new Error('something else'))).toBe(false)
    })
})

describe('naming a failure', () => {
    it('keeps the first name, so an inner cause is not renamed by the step around it', async () => {
        const inner = nameRoutineStartFailure(new Error('Scheduler stopped'), 'shutdown')
        await expect(routineStartStep('preparation', () => { throw inner })).rejects.toBe(inner)
        expect(scheduled(inner)).toBe('shutdown')
    })

    it('names only the errors a step says are its own', async () => {
        const network = new Error('fetch failed')
        await expect(routineStartStep('saved-model', async () => { throw network }, isConflict)).rejects.toBe(network)
        expect(scheduled(network)).toBe('unclassified')
        const conflict = new HttpError(409, 'incomplete')
        await expect(routineStartStep('saved-model', async () => { throw conflict }, isConflict)).rejects.toBe(conflict)
        expect(scheduled(conflict)).toBe('saved-model')
    })

    it('counts exactly the four standing faults', () => {
        const counting = (Object.keys(ROUTINE_START_FAILURES) as RoutineStartFailure[]).filter(routineStartFailureCounts)
        expect(counting.sort()).toEqual(['preparation', 'provider', 'saved-model', 'setup-pending'])
    })
})
