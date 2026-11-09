import { describe, expect, it } from 'vitest'

import { desktopGettingStartedResponse, desktopGettingStartedSteps, desktopGettingStartedSummary } from './progress'

describe('desktopGettingStartedSteps', () => {
    it('starts from an empty board and does not invent hosted steps', () => {
        const steps = desktopGettingStartedSteps({ coworkers: 0, modelChats: 0, connectedProviders: 0, schedules: 0 })
        expect(steps.map(step => step.id)).toEqual(['first_coworker', 'model', 'schedule'])
        expect(steps.every(step => !step.done && !step.unavailable)).toBe(true)
        expect(desktopGettingStartedSummary(steps)).toMatchObject({ done: 0, total: 3, complete: false, next: { id: 'first_coworker' } })
    })

    it('marks only the facts that are actually present', () => {
        const steps = desktopGettingStartedSteps({ coworkers: 2, modelChats: 1, connectedProviders: 0, schedules: 0 })
        expect(steps.map(step => step.done)).toEqual([true, true, false])
        expect(desktopGettingStartedSummary(steps).complete).toBe(false)
        expect(desktopGettingStartedSummary(steps).next?.id).toBe('schedule')
    })

    it('does not treat an unread routine list as zero or as done', () => {
        const steps = desktopGettingStartedSteps({ coworkers: 1, modelChats: 1, connectedProviders: null, schedules: null })
        const schedule = steps.find(step => step.id === 'schedule')
        expect(schedule).toMatchObject({ done: false, unavailable: true })
        expect(schedule?.description).toContain('could not be read')
        expect(desktopGettingStartedSummary(steps).complete).toBe(false)
        expect(desktopGettingStartedSummary(steps).done).toBe(2)
    })

    it('counts a saved routine, including a disabled one that still exists', () => {
        const steps = desktopGettingStartedSteps({ coworkers: 1, modelChats: 0, connectedProviders: 1, schedules: 1 })
        expect(desktopGettingStartedSummary(steps).complete).toBe(true)
    })

    it('rejects negative and non-finite counts instead of marking them done', () => {
        const steps = desktopGettingStartedSteps({ coworkers: -1, modelChats: Number.NaN, connectedProviders: null, schedules: Number.POSITIVE_INFINITY })
        expect(steps.every(step => !step.done)).toBe(true)
        expect(steps.find(step => step.id === 'schedule')?.unavailable).toBe(true)
    })
})

describe('desktopGettingStartedResponse', () => {
    it('binds the snapshot to one workspace and keeps dismiss off the milestone list', () => {
        const open = desktopGettingStartedResponse(4, false, { coworkers: 1, modelChats: 0, connectedProviders: 0, schedules: 0 })
        const hidden = desktopGettingStartedResponse(4, true, { coworkers: 1, modelChats: 0, connectedProviders: 0, schedules: 0 })
        expect(open.workspaceId).toBe(4)
        expect(open.dismissed).toBe(false)
        expect(hidden.dismissed).toBe(true)
        expect(open.steps.map(step => step.id)).toEqual(hidden.steps.map(step => step.id))
        expect(open.complete).toBe(false)
    })
})
